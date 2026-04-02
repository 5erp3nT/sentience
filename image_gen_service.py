import os
import time
import base64
import asyncio
import httpx
from urllib import parse
import random
import json
from fastapi import FastAPI, Request
from pydantic import BaseModel
import uvicorn
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

app = FastAPI(title="Sentience Pollinations-Proxy Service")

class GenerateRequest(BaseModel):
    prompt: str
    width: int = 1024
    height: int = 1024
    num_inference_steps: int = 4
    guidance_scale: float = 1.0

@app.get("/health")
async def health():
    return {"status": "ok", "backend": "pollinations.ai", "model": "zimage"}

@app.post("/generate")
async def generate(request: GenerateRequest, req: Request):
    async def event_generator():
        print(f"Generating image (zimage) via Pollinations.ai for prompt: {request.prompt}")
        
        try:
            # Yield initial progress
            yield json.dumps({"type": "progress", "percent": 10, "step": 1, "total": 4}) + "\n"
            await asyncio.sleep(0.5)
            
            seed = random.randint(0, 1000000000)
            encoded_prompt = parse.quote(request.prompt)
            # Use the official gen.pollinations.ai endpoint and zimage model
            url = f"https://gen.pollinations.ai/image/{encoded_prompt}?width={request.width}&height={request.height}&seed={seed}&model=zimage&nologo=true"
            
            headers = {}
            p_key = os.getenv("POLLINATIONS_KEY")
            if p_key:
                headers["Authorization"] = f"Bearer {p_key}"
                print(f"DEBUG: Using Pollinations Proxy API Key (starting with {p_key[:5]}...)")
            
            yield json.dumps({"type": "progress", "percent": 40, "step": 2, "total": 4}) + "\n"
            
            async with httpx.AsyncClient() as client:
                # FOLLOW REDIRECTS IS CRITICAL; Also gen.pollinations.ai is the correct API endpoint
                resp = await client.get(url, timeout=60.0, headers=headers, follow_redirects=True)
                
                yield json.dumps({"type": "progress", "percent": 80, "step": 3, "total": 4}) + "\n"
                
                if resp.status_code == 200:
                    ct = resp.headers.get("Content-Type", "").lower()
                    if "image" not in ct:
                         yield json.dumps({"type": "error", "message": f"Non-image response ({ct}). API might be rate-limited."}) + "\n"
                    else:
                        img_str = base64.b64encode(resp.content).decode("utf-8")
                        yield json.dumps({"type": "progress", "percent": 100, "step": 4, "total": 4}) + "\n"
                        yield json.dumps({"type": "done", "image_b64": img_str}) + "\n"
                else:
                    yield json.dumps({"type": "error", "message": f"Pollinations API error: {resp.status_code}"}) + "\n"
                    
        except Exception as e:
            print(f"Pollinations proxy internal error: {e}")
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8346)
