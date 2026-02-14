from fastapi import FastAPI, APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import json
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime
from bson import ObjectId
import razorpay

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Razorpay client (demo keys)
razorpay_client = razorpay.Client(auth=("rzp_test_demo123456", "demo_secret_key_123456"))

app = FastAPI()
api_router = APIRouter(prefix="/api")

# WebSocket manager for chat
class ConnectionManager:
    def __init__(self):
        self.active_connections: dict = {}

    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        self.active_connections[user_id] = websocket

    def disconnect(self, user_id: str):
        if user_id in self.active_connections:
            del self.active_connections[user_id]

    async def send_message(self, user_id: str, message: dict):
        if user_id in self.active_connections:
            try:
                await self.active_connections[user_id].send_json(message)
            except Exception:
                pass

manager = ConnectionManager()

# Models
class UserCreate(BaseModel):
    phone: str
    role: str  # "employer" or "seeker"
    name: str
    businessName: Optional[str] = None
    location: str
    languages: List[str] = []
    skills: List[str] = []  # For seekers

class User(UserCreate):
    id: str
    freeJobsRemaining: int = 2
    createdAt: datetime = Field(default_factory=datetime.utcnow)

class JobCreate(BaseModel):
    title: str
    category: str
    description: str
    salary: str
    location: str
    jobType: str  # Full-time, Part-time
    experience: str
    education: str
    languages: List[str]
    skills: List[str]

class Job(JobCreate):
    id: str
    employerId: str
    employerName: str
    employerPhone: str
    businessName: Optional[str] = None
    postedDate: datetime = Field(default_factory=datetime.utcnow)
    status: str = "active"  # active, filled, closed
    isPaid: bool = False
    applicationsCount: int = 0

class ApplicationCreate(BaseModel):
    jobId: str
    coverLetter: Optional[str] = None

class Application(ApplicationCreate):
    id: str
    seekerId: str
    seekerName: str
    seekerPhone: str
    seekerSkills: List[str]
    status: str = "pending"  # pending, shortlisted, rejected
    appliedDate: datetime = Field(default_factory=datetime.utcnow)

class MessageCreate(BaseModel):
    receiverId: str
    jobId: str
    message: str

class Message(MessageCreate):
    id: str
    senderId: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    read: bool = False

class PaymentOrderCreate(BaseModel):
    amount: int  # in paise

class PaymentVerify(BaseModel):
    razorpayOrderId: str
    razorpayPaymentId: str
    razorpaySignature: str

class OTPRequest(BaseModel):
    phone: str

class OTPVerify(BaseModel):
    phone: str
    otp: str

# Helper function to convert ObjectId to string
def serialize_doc(doc):
    if doc and "_id" in doc:
        doc["id"] = str(doc["_id"])
        del doc["_id"]
    return doc

    # health check route
@api_router.get("/health")
async def health_check():
    try:
        # Ping MongoDB
        await db.command("ping")
        db_status = "connected"
    except Exception:
        db_status = "disconnected"

    return {
        "status": "healthy" if db_status == "connected" else "degraded",
        "database": db_status,
        "service": "kolkata-job-platform",
        "timestamp": datetime.utcnow()
    }


# Auth endpoints (Mock OTP)
@api_router.post("/auth/send-otp")
async def send_otp(request: OTPRequest):
    # Mock OTP - in production, use Firebase or MSG91
    # For testing, always accept OTP: 123456
    return {"success": True, "message": "OTP sent successfully. Use 123456 for testing"}

@api_router.post("/auth/verify-otp")
async def verify_otp(request: OTPVerify):
    # Mock verification - accept any 6-digit OTP or 123456
    if len(request.otp) == 6:
        # Check if user exists
        user = await db.users.find_one({"phone": request.phone})
        if user:
            user = serialize_doc(user)
            return {"success": True, "user": user, "isNewUser": False}
        return {"success": True, "isNewUser": True}
    return {"success": False, "message": "Invalid OTP"}

# User endpoints
@api_router.post("/users", response_model=User)
async def create_user(user: UserCreate):
    user_dict = user.dict()
    user_dict["freeJobsRemaining"] = 2
    user_dict["createdAt"] = datetime.utcnow()
    result = await db.users.insert_one(user_dict)
    user_dict["id"] = str(result.inserted_id)
    return user_dict

@api_router.get("/users/{user_id}", response_model=User)
async def get_user(user_id: str):
    user = await db.users.find_one({"_id": ObjectId(user_id)})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return serialize_doc(user)

@api_router.put("/users/{user_id}", response_model=User)
async def update_user(user_id: str, user: UserCreate):
    result = await db.users.update_one(
        {"_id": ObjectId(user_id)},
        {"$set": user.dict()}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    return await get_user(user_id)

# Job endpoints
@api_router.post("/jobs", response_model=Job)
async def create_job(job: JobCreate, employer_id: str):
    # Get employer details
    employer = await db.users.find_one({"_id": ObjectId(employer_id)})
    if not employer:
        raise HTTPException(status_code=404, detail="Employer not found")
    
    if employer["role"] != "employer":
        raise HTTPException(status_code=403, detail="Only employers can post jobs")
    
    job_dict = job.dict()
    job_dict["employerId"] = employer_id
    job_dict["employerName"] = employer["name"]
    job_dict["employerPhone"] = employer["phone"]
    job_dict["businessName"] = employer.get("businessName")
    job_dict["postedDate"] = datetime.utcnow()
    job_dict["status"] = "active"
    job_dict["applicationsCount"] = 0
    
    # Check if free jobs available
    if employer.get("freeJobsRemaining", 0) > 0:
        job_dict["isPaid"] = False
        # Decrement free jobs
        await db.users.update_one(
            {"_id": ObjectId(employer_id)},
            {"$inc": {"freeJobsRemaining": -1}}
        )
    else:
        # Requires payment
        raise HTTPException(status_code=402, detail="Payment required")
    
    result = await db.jobs.insert_one(job_dict)
    job_dict["id"] = str(result.inserted_id)
    return job_dict

@api_router.get("/jobs", response_model=List[Job])
async def get_jobs(
    category: Optional[str] = None,
    location: Optional[str] = None,
    jobType: Optional[str] = None,
    minSalary: Optional[str] = None,
    experience: Optional[str] = None,
    education: Optional[str] = None,
    language: Optional[str] = None,
    skill: Optional[str] = None,
    search: Optional[str] = None
):
    query = {"status": "active"}
    
    if category:
        query["category"] = category
    if location:
        query["location"] = {"$regex": location, "$options": "i"}
    if jobType:
        query["jobType"] = jobType
    if experience:
        query["experience"] = experience
    if education:
        query["education"] = education
    if language:
        query["languages"] = language
    if skill:
        query["skills"] = {"$regex": skill, "$options": "i"}
    if search:
        query["$or"] = [
            {"title": {"$regex": search, "$options": "i"}},
            {"description": {"$regex": search, "$options": "i"}}
        ]
    
    jobs = await db.jobs.find(query).sort("postedDate", -1).to_list(100)
    return [serialize_doc(job) for job in jobs]

@api_router.get("/jobs/{job_id}", response_model=Job)
async def get_job(job_id: str):
    job = await db.jobs.find_one({"_id": ObjectId(job_id)})
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return serialize_doc(job)

@api_router.get("/jobs/employer/{employer_id}", response_model=List[Job])
async def get_employer_jobs(employer_id: str):
    jobs = await db.jobs.find({"employerId": employer_id}).sort("postedDate", -1).to_list(100)
    return [serialize_doc(job) for job in jobs]

@api_router.put("/jobs/{job_id}/status")
async def update_job_status(job_id: str, status: str):
    result = await db.jobs.update_one(
        {"_id": ObjectId(job_id)},
        {"$set": {"status": status}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"success": True}

# Application endpoints
@api_router.post("/applications", response_model=Application)
async def create_application(application: ApplicationCreate, seeker_id: str):
    # Get seeker details
    seeker = await db.users.find_one({"_id": ObjectId(seeker_id)})
    if not seeker:
        raise HTTPException(status_code=404, detail="User not found")
    
    if seeker["role"] != "seeker":
        raise HTTPException(status_code=403, detail="Only job seekers can apply")
    
    # Check if already applied
    existing = await db.applications.find_one({
        "jobId": application.jobId,
        "seekerId": seeker_id
    })
    if existing:
        raise HTTPException(status_code=400, detail="Already applied to this job")
    
    app_dict = application.dict()
    app_dict["seekerId"] = seeker_id
    app_dict["seekerName"] = seeker["name"]
    app_dict["seekerPhone"] = seeker["phone"]
    app_dict["seekerSkills"] = seeker.get("skills", [])
    app_dict["status"] = "pending"
    app_dict["appliedDate"] = datetime.utcnow()
    
    result = await db.applications.insert_one(app_dict)
    app_dict["id"] = str(result.inserted_id)
    
    # Increment applications count
    await db.jobs.update_one(
        {"_id": ObjectId(application.jobId)},
        {"$inc": {"applicationsCount": 1}}
    )
    
    return app_dict

@api_router.get("/applications/job/{job_id}", response_model=List[Application])
async def get_job_applications(job_id: str):
    applications = await db.applications.find({"jobId": job_id}).sort("appliedDate", -1).to_list(100)
    return [serialize_doc(app) for app in applications]

@api_router.get("/applications/seeker/{seeker_id}", response_model=List[Application])
async def get_seeker_applications(seeker_id: str):
    applications = await db.applications.find({"seekerId": seeker_id}).sort("appliedDate", -1).to_list(100)
    return [serialize_doc(app) for app in applications]

@api_router.put("/applications/{application_id}/status")
async def update_application_status(application_id: str, status: str):
    result = await db.applications.update_one(
        {"_id": ObjectId(application_id)},
        {"$set": {"status": status}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Application not found")
    return {"success": True}

# Message endpoints
@api_router.post("/messages", response_model=Message)
async def create_message(message: MessageCreate, sender_id: str):
    msg_dict = message.dict()
    msg_dict["senderId"] = sender_id
    msg_dict["timestamp"] = datetime.utcnow()
    msg_dict["read"] = False
    
    result = await db.messages.insert_one(msg_dict)
    msg_dict["id"] = str(result.inserted_id)
    
    # Serialize for JSON (datetime -> ISO string) and send via WebSocket if receiver connected
    msg_for_ws = {
        "id": msg_dict["id"],
        "senderId": msg_dict["senderId"],
        "receiverId": msg_dict["receiverId"],
        "message": msg_dict["message"],
        "jobId": msg_dict.get("jobId", ""),
        "timestamp": msg_dict["timestamp"].isoformat() + "Z",
        "read": msg_dict["read"],
    }
    await manager.send_message(message.receiverId, {"type": "new_message", "payload": msg_for_ws})
    
    return {**msg_dict, "timestamp": msg_for_ws["timestamp"]}

@api_router.get("/messages/{user_id}", response_model=List[Message])
async def get_user_messages(user_id: str, other_user_id: str):
    messages = await db.messages.find({
        "$or": [
            {"senderId": user_id, "receiverId": other_user_id},
            {"senderId": other_user_id, "receiverId": user_id}
        ]
    }).sort("timestamp", 1).to_list(1000)
    return [serialize_doc(msg) for msg in messages]

@api_router.get("/messages/conversations/{user_id}")
async def get_conversations(user_id: str):
    # Get all unique users that have messaged with this user
    pipeline = [
        {"$match": {
            "$or": [{"senderId": user_id}, {"receiverId": user_id}]
        }},
        {"$sort": {"timestamp": -1}},
        {"$group": {
            "_id": {
                "$cond": [
                    {"$eq": ["$senderId", user_id]},
                    "$receiverId",
                    "$senderId"
                ]
            },
            "lastMessage": {"$first": "$$ROOT"}
        }}
    ]
    
    conversations = await db.messages.aggregate(pipeline).to_list(100)
    result = []
    for conv in conversations:
        other_user_id = conv["_id"]
        other_user = await db.users.find_one({"_id": ObjectId(other_user_id)})
        if other_user:
            result.append({
                "userId": other_user_id,
                "userName": other_user["name"],
                "lastMessage": serialize_doc(conv["lastMessage"])
            })
    return result

# Payment endpoints
@api_router.post("/payments/create-order")
async def create_payment_order(order: PaymentOrderCreate, employer_id: str):
    # Create Razorpay order (mock for demo)
    try:
        # In production, this would work with real keys
        # order_data = razorpay_client.order.create({
        #     "amount": order.amount,
        #     "currency": "INR",
        #     "receipt": f"job_post_{employer_id}"
        # })
        
        # Mock order for demo
        order_data = {
            "id": f"order_demo_{datetime.utcnow().timestamp()}",
            "amount": order.amount,
            "currency": "INR",
            "status": "created"
        }
        
        return order_data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/payments/verify")
async def verify_payment(payment: PaymentVerify, employer_id: str):
    # In production, verify signature using Razorpay
    # For demo, just accept and credit free jobs
    await db.users.update_one(
        {"_id": ObjectId(employer_id)},
        {"$inc": {"freeJobsRemaining": 1}}
    )
    
    # Save transaction
    transaction = {
        "employerId": employer_id,
        "amount": 5000,  # ₹50
        "razorpayOrderId": payment.razorpayOrderId,
        "razorpayPaymentId": payment.razorpayPaymentId,
        "status": "success",
        "createdAt": datetime.utcnow()
    }
    await db.transactions.insert_one(transaction)
    
    return {"success": True, "message": "Payment verified"}

# WebSocket endpoint for real-time messaging
@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    await manager.connect(websocket, user_id)
    try:
        while True:
            # Receive (ping/text) to keep connection alive; client can send pings
            data = await websocket.receive_text()
            try:
                obj = json.loads(data)
                if obj.get("type") == "ping":
                    await manager.send_message(user_id, {"type": "pong"})
            except (json.JSONDecodeError, KeyError):
                pass
    except WebSocketDisconnect:
        manager.disconnect(user_id)
    except Exception:
        manager.disconnect(user_id)

app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
