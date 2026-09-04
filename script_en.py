import os
import re
import sys
import json
import random
import shutil
import subprocess
from datetime import datetime, timezone
from groq import Groq
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("❌ HATA: Supabase URL veya KEY eksik!")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

CATEGORIES = [
    "Tech & Artificial Intelligence Dilemmas",
    "Modern Workplace & Remote Work Culture",
    "Digital Privacy & Cybersecurity Quirks",
    "Pop Culture, Cinema & Underappreciated Shows",
    "Video Games, Indie Studios & Gaming Nostalgia",
    "Modern Philosophy, Urban Burnout & Social Media",
    "Space Exploration & Emerging Science",
    "Everyday Life Peculiarities & Unpopular Opinions"
]

def normalize_text(text: str) -> str:
    clean = text.lower()
    clean = re.sub(r"[^\w\s]", "", clean)
    return re.sub(r"\s+", " ", clean).strip()

def english_title(text: str) -> str:
    return text.strip().title()

def get_existing_en_topics() -> set:
    """Supabase'de daha önce oluşturulmuş İngilizce başlıkları çeker."""
    cached = set()
    try:
        res = supabase.table("topics").select("topic_name").eq("en", True).execute()
        for row in res.data or []:
            name = row.get("topic_name")
            if name:
                cached.add(normalize_text(name))
    except Exception as e:
        print(f"⚠️ Mevcut başlıkları çekerken hata: {e}")
    return cached

def generate_topic_from_ai() -> str:
    category = random.choice(CATEGORIES)
    system_prompt = (
        "You are an active user and curator of a global internet forum/dictionary (like Reddit, Urban Dictionary, or Hacker News). "
        "Generate ONE catchy, discussion-sparking, natural topic title in English.\n"
        "RULES:\n"
        "1. Strictly output ONLY the topic title text.\n"
        "2. Do not use quotation marks, lists, or ending periods.\n"
        "3. Length must be between 2 to 7 words.\n"
        "4. Tone: Casual, provocative, intriguing, or culturally relatable."
    )
    user_prompt = f"Create a fresh topic title about: {category}"

    if groq_client:
        for model in ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]:
            try:
                chat = groq_client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    temperature=0.85
                )
                text = chat.choices[0].message.content.strip().strip('"\'')
                if text:
                    return english_title(text)
            except Exception:
                continue

    fallbacks = [
        "The Illusion Of Modern Digital Detox",
        "Why Video Game Sequels Keep Disappointing",
        "The Silent Death Of True Online Privacy",
        "Working Remotely Is Ruining Spontaneity",
        "Overrated Masterpieces In Modern Cinema"
    ]
    return english_title(random.choice(fallbacks))

def save_and_run(unique_topic: str) -> bool:
    try:
        # en sütununa True verilerek kaydedilir
        payload = {
            "topic_name": unique_topic,
            "en": True
        }
        res = supabase.table("topics").insert(payload).execute()
        if not res.data:
            print("✕ Başlık DB'ye eklenemedi.")
            return False

        topic_id = str(res.data[0]["topic_id"])
        print(f"✅ Yeni EN başlık oluşturuldu: #{unique_topic} (topic_id: {topic_id})")

        print(f"\n🤖 #{unique_topic} için EN entry botları tetikleniyor...")
        npx_path = shutil.which("npx") or shutil.which("npx.cmd") or "npx"
        use_shell = os.name == "nt"

        subprocess.run(
            [npx_path, "tsx", "scripts/bot/runner_en.ts", topic_id, unique_topic],
            shell=use_shell,
            check=True
        )
        return True
    except Exception as e:
        print(f"✕ İşlem hatası: {e}")
        return False

if __name__ == "__main__":
    print("🌍 Yeni İngilizce başlık üretimi başlatılıyor...")
    existing_topics = get_existing_en_topics()

    chosen_topic = None
    for attempt in range(5):
        candidate = generate_topic_from_ai()
        if normalize_text(candidate) not in existing_topics:
            chosen_topic = candidate
            break

    if not chosen_topic:
        print("✕ Özgün bir başlık türetilemedi, bir sonraki döngü bekleniyor.")
        sys.exit(0)

    save_and_run(chosen_topic)
