import sys
import os

# Monkeypatch transformers 5.x to be compatible with diffusers 0.29.0
# Diffusers expects certain constants in transformers.utils that might be missing or moved
try:
    import transformers.utils
    if not hasattr(transformers.utils, "FLAX_WEIGHTS_NAME"):
        transformers.utils.FLAX_WEIGHTS_NAME = "flax_model.msgpack"
    if not hasattr(transformers.utils, "SAFE_WEIGHTS_NAME"):
        transformers.utils.SAFE_WEIGHTS_NAME = "model.safetensors"
    if not hasattr(transformers.utils, "WEIGHTS_NAME"):
        transformers.utils.WEIGHTS_NAME = "pytorch_model.bin"
except ImportError:
    pass

import time
import base64
import io
import torch
import asyncio
import signal
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
from diffusers import AutoPipelineForText2Image
import uvicorn
from PIL import Image

app = FastAPI(title="Sentience SDXL-Turbo Service")

# Global state
pipe = None
last_active_time = time.time()
IDLE_TIMEOUT = 600  # 10 minutes for better UX
is_loading = False

class GenerateRequest(BaseModel):
    prompt: str
    width: int = 512
    height: int = 512
    num_inference_steps: int = 1
    guidance_scale: float = 0.0

def load_model():
    global pipe, is_loading
    if pipe is not None:
        return
    
    is_loading = True
    print("Loading SDXL-Turbo model into VRAM...")
    try:
        # Using SDXL-Turbo for 1-step generation
        # float16 is essential for 8GB VRAM
        model_id = "stabilityai/sdxl-turbo"
        pipe = AutoPipelineForText2Image.from_pretrained(
            model_id, 
            torch_dtype=torch.float16, 
            variant="fp16"
        )
        # pipe.to("cuda") # REMOVED: too aggressive for 8GB cards
        
        # CPU Offloading: Essential for 8GB VRAM to coexist with other AI models
        # This only moves parts of the model to GPU when they are actively needed
        pipe.enable_model_cpu_offload()
        
        # VAE memory optimizations (crucial for the high-res decoding stage)
        pipe.enable_vae_slicing()
        pipe.enable_vae_tiling()
        
        # Performance optimizations
        if hasattr(pipe, "enable_xformers_memory_efficient_attention"):
             try:
                 pipe.enable_xformers_memory_efficient_attention()
             except:
                 pass
        
        print("SDXL-Turbo loaded successfully.")
    except Exception as e:
        print(f"Error loading model: {e}")
        raise e
    finally:
        is_loading = False

def update_activity():
    global last_active_time
    last_active_time = time.time()

async def shutdown_checker():
    """Background task to shut down the server if idle."""
    while True:
        await asyncio.sleep(30)
        idle_duration = time.time() - last_active_time
        if pipe is not None and idle_duration > IDLE_TIMEOUT:
            print(f"Idle timeout reached ({idle_duration:.0f}s). Shutting down to free VRAM...")
            # Trigger process exit
            os.kill(os.getpid(), signal.SIGTERM)

@app.on_event("startup")
async def startup_event():
    # We don't load the model immediately here to keep startup fast
    # but we start the shutdown checker
    asyncio.create_task(shutdown_checker())
    update_activity()

@app.get("/health")
async def health():
    return {"status": "ok", "loaded": pipe is not None, "loading": is_loading}

@app.post("/generate")
async def generate(request: GenerateRequest):
    global pipe
    update_activity()
    
    if pipe is None:
        if is_loading:
            raise HTTPException(status_code=503, detail="Model is currently loading")
        load_model()
    
    try:
        # Pre-inference cleanup
        torch.cuda.empty_cache()
        import gc
        gc.collect()

        print(f"Generating image for prompt: {request.prompt}")
        # SDXL-Turbo is optimized for 1 step and 0 guidance
        image = pipe(
            prompt=request.prompt,
            num_inference_steps=request.num_inference_steps,
            guidance_scale=request.guidance_scale,
            width=request.width,
            height=request.height
        ).images[0]
        
        # Post-inference cleanup
        update_activity()
        torch.cuda.empty_cache()
        buffered = io.BytesIO()
        image.save(buffered, format="JPEG", quality=85)
        img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
        
        update_activity()
        return {"image_b64": img_str}
    except Exception as e:
        print(f"Generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    # Note: uvicorn is used to run the app
    uvicorn.run(app, host="0.0.0.0", port=8346)
