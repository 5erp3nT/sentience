import sqlite3
import os
import chromadb
import base64
import hashlib
from datetime import datetime

class MemoryManager:
    def __init__(self, db_path="memory.db", chroma_path="chroma_db", memory_dir="memory"):
        self.db_path = db_path
        self.memory_dir = memory_dir
        self.durable_file = "MEMORY.md" # Keep in root for user visibility
        
        if not os.path.exists(self.memory_dir):
            os.makedirs(self.memory_dir)
        
        if not os.path.exists(self.durable_file):
            with open(self.durable_file, "w") as f:
                f.write("# Durable Memory\n\nThis file stores permanent facts and preferences about the user.\n\n## Known Facts\n- User is a Linux developer.\n")

        # Initialize SQLite for conversation history
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.create_tables()
        
        # Initialize ChromaDB for semantic search
        self.chroma_client = chromadb.PersistentClient(path=chroma_path)
        self.collection = self.chroma_client.get_or_create_collection(name="interactions")

    def create_tables(self):
        self.conn.execute('''
            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                role TEXT,
                content TEXT,
                attachments TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        # Migration: add attachments if it doesn't exist
        try:
            self.conn.execute("ALTER TABLE history ADD COLUMN attachments TEXT")
            self.conn.commit()
        except:
            pass # already exists
        self.conn.execute('''
            CREATE TABLE IF NOT EXISTS history_images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER,
                image_path TEXT,
                prompt TEXT,
                FOREIGN KEY(message_id) REFERENCES history(id)
            )
        ''')
        self.conn.commit()

    def add_message(self, session_id, role, content, images=None, attachments=None):
        # 1. Store in SQLite
        import json
        attachments_json = json.dumps(attachments) if attachments else None
        cursor = self.conn.execute(
            "INSERT INTO history (session_id, role, content, attachments) VALUES (?, ?, ?, ?)",
            (session_id, role, content, attachments_json)
        )
        msg_id = cursor.lastrowid
        
        # 2. Store Images if present
        if images:
            image_dir = "cache/images"
            if not os.path.exists(image_dir):
                os.makedirs(image_dir)
                
            for img in images:
                # Handle different image formats (raw base64 string or dict with prompt)
                img_data = img
                img_prompt = None
                if isinstance(img, dict):
                    img_data = img.get("data")
                    img_prompt = img.get("prompt")
                
                if not img_data or not isinstance(img_data, str):
                    continue
                
                # Sanitize: strip metadata prefix if present
                clean_b64 = img_data
                if "," in img_data:
                    clean_b64 = img_data.split(",")[1]
                
                # Generate unique filename using hash
                try:
                    raw_bytes = base64.b64decode(clean_b64)
                    img_hash = hashlib.sha256(raw_bytes).hexdigest()
                    filename = f"{img_hash[:16]}_{int(datetime.now().timestamp())}.jpg"
                    filepath = os.path.join(image_dir, filename)
                    
                    with open(filepath, "wb") as f:
                        f.write(raw_bytes)
                    
                    self.conn.execute(
                        "INSERT INTO history_images (message_id, image_path, prompt) VALUES (?, ?, ?)",
                        (msg_id, filepath, img_prompt)
                    )
                except Exception as e:
                    print(f"Error caching image: {e}")

        self.conn.commit()
        
        # 3. Log to Daily File (OpenClaw style)
        date_str = datetime.now().strftime("%Y-%m-%d")
        daily_file = os.path.join(self.memory_dir, f"{date_str}.md")
        with open(daily_file, "a") as f:
            time_str = datetime.now().strftime("%H:%M:%S")
            img_marker = f" [Images: {len(images)}]" if images else ""
            at_marker = f" [Attachments: {len(attachments)}]" if attachments else ""
            f.write(f"### [{time_str}] {role.upper()}{img_marker}{at_marker}\n{content}\n\n")

        # 4. Semantic Indexing for user messages
        if role == 'user':
            doc_id = f"{session_id}_{datetime.now().timestamp()}"
            self.collection.add(
                documents=[content],
                metadatas=[{"session_id": session_id, "role": role}],
                ids=[doc_id]
            )

    def get_recent_messages(self, session_id, limit=20):
        cursor = self.conn.execute('''
            SELECT id, role, content, attachments FROM (
                SELECT id, role, content, attachments, timestamp 
                FROM history 
                WHERE session_id = ? 
                ORDER BY timestamp DESC, id DESC 
                LIMIT ?
            ) ORDER BY timestamp ASC, id ASC
        ''', (session_id, limit))
        
        results = []
        import json
        for row in cursor.fetchall():
            msg_id, role, content, attachments_raw = row
            attachments = json.loads(attachments_raw) if attachments_raw else None
            msg_dict = {"role": role, "content": content}
            if attachments:
                msg_dict["attachments"] = attachments
            
            # Fetch associated images
            img_cursor = self.conn.execute(
                "SELECT image_path, prompt FROM history_images WHERE message_id = ?",
                (msg_id,)
            )
            images = []
            for img_row in img_cursor.fetchall():
                path, prompt = img_row
                if os.path.exists(path):
                    try:
                        with open(path, "rb") as f:
                            b64 = base64.b64encode(f.read()).decode("utf-8")
                            images.append({"data": b64, "prompt": prompt})
                    except Exception as e:
                        print(f"Error loading cached image {path}: {e}")
            
            if images:
                msg_dict["images"] = images
            results.append(msg_dict)
            
        return results

    def get_durable_memories(self):
        """Reads the human-readable MEMORY.md file."""
        if os.path.exists(self.durable_file):
            with open(self.durable_file, "r") as f:
                return f.read()
        return ""

    def update_durable_memory(self, fact):
        """Adds a new fact to the MEMORY.md file if it doesn't already exist."""
        current = self.get_durable_memories()
        if fact.lower() in current.lower():
            return "Already known."
            
        # Append to the end of the file or specific section
        with open(self.durable_file, "a") as f:
            f.write(f"- {fact}\n")
        
        # Also index for semantic search
        doc_id = f"fact_{datetime.now().timestamp()}"
        self.collection.add(
            documents=[fact],
            metadatas=[{"type": "fact"}],
            ids=[doc_id]
        )
        return "Added to durable memory."

    def get_all_cached_images(self, limit=10):
        """Returns metadata for the most recently cached images."""
        cursor = self.conn.execute('''
            SELECT hi.id, hi.image_path, hi.prompt, h.timestamp 
            FROM history_images hi
            JOIN history h ON hi.message_id = h.id
            ORDER BY h.timestamp DESC
            LIMIT ?
        ''', (limit,))
        
        results = []
        for row in cursor.fetchall():
            img_id, path, prompt, ts = row
            results.append({
                "id": img_id,
                "path": path,
                "prompt": prompt or "No prompt recorded",
                "timestamp": ts
            })
        return results

    def get_cached_image_by_id(self, img_id):
        """Retrieves base64 data and metadata for a specific cached image."""
        cursor = self.conn.execute("SELECT image_path, prompt FROM history_images WHERE id = ?", (img_id,))
        row = cursor.fetchone()
        if row and os.path.exists(row[0]):
            with open(row[0], "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
                return b64, row[1]
        return None, None

    def search_memory(self, query, top_k=3):
        if not query.strip():
            return []
        try:
            results = self.collection.query(
                query_texts=[query],
                n_results=top_k
            )
            return results.get('documents', [[]])[0] if results else []
        except Exception as e:
            print("ChromaDB search error:", e)
            return []

    def clear_memory(self, session_id=None):
        if session_id:
            self.conn.execute("DELETE FROM history WHERE session_id = ?", (session_id,))
            self.conn.commit()
        else:
            self.conn.execute("DELETE FROM history")
            self.conn.commit()

    def close(self):
        self.conn.close()
