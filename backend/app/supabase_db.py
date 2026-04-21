import os
from pathlib import Path
from typing import Any, Dict, Optional
from supabase import create_client, Client
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

class SupabaseDB:
    client: Optional[Client] = None
    bucket_name: str = "pose-captures"

    def __init__(self):
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_KEY")
        self.bucket_name = os.getenv("SUPABASE_BUCKET_NAME", "pose-captures")

        if url and key:
            try:
                self.client = create_client(url, key)
                print("Supabase client initialized.")
            except Exception as e:
                print(f"Failed to initialize Supabase client: {e}")
        else:
            print("WARNING: SUPABASE_URL or SUPABASE_KEY not found in environment.")

supabase_db = SupabaseDB()

async def push_metadata_to_supabase(data: Dict[str, Any]):
    """Insert capture metadata into Supabase 'captures' table."""
    if not supabase_db.client:
        return None
    
    try:
        # We use 'upsert' or 'insert' depending on preference.
        # Here we use insert since capture_id is unique.
        response = supabase_db.client.table("captures").insert(data).execute()
        return response
    except Exception as e:
        print(f"Failed to push metadata to Supabase: {e}")
        return None

async def upload_file_to_supabase(file_path: Path, remote_path: str) -> Optional[str]:
    """Upload a file to Supabase Storage and return its public URL or path."""
    if not supabase_db.client:
        return None
    
    try:
        with open(file_path, "rb") as f:
            supabase_db.client.storage.from_(supabase_db.bucket_name).upload(
                path=remote_path,
                file=f,
                file_options={"upsert": "true"}
            )
        
        # Get public URL
        res = supabase_db.client.storage.from_(supabase_db.bucket_name).get_public_url(remote_path)
        return res
    except Exception as e:
        print(f"Failed to upload file {file_path} to Supabase: {e}")
        return None
