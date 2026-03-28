import sqlite3
import os
import chromadb
import re
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
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        self.conn.commit()

    def add_message(self, session_id, role, content):
        # 1. Store in SQLite
        self.conn.execute(
            "INSERT INTO history (session_id, role, content) VALUES (?, ?, ?)",
            (session_id, role, content)
        )
        self.conn.commit()
        
        # 2. Log to Daily File (OpenClaw style)
        date_str = datetime.now().strftime("%Y-%m-%d")
        daily_file = os.path.join(self.memory_dir, f"{date_str}.md")
        with open(daily_file, "a") as f:
            time_str = datetime.now().strftime("%H:%M:%S")
            f.write(f"### [{time_str}] {role.upper()}\n{content}\n\n")

        # 3. Semantic Indexing for user messages
        if role == 'user':
            doc_id = f"{session_id}_{datetime.now().timestamp()}"
            self.collection.add(
                documents=[content],
                metadatas=[{"session_id": session_id, "role": role}],
                ids=[doc_id]
            )

    def get_recent_messages(self, session_id, limit=20):
        cursor = self.conn.execute('''
            SELECT role, content FROM (
                SELECT role, content, timestamp, id 
                FROM history 
                WHERE session_id = ? 
                ORDER BY timestamp DESC, id DESC 
                LIMIT ?
            ) ORDER BY timestamp ASC, id ASC
        ''', (session_id, limit))
        return [{"role": row[0], "content": row[1]} for row in cursor.fetchall()]

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
