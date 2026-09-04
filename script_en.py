import os
import re
import sys
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
    "Artificial Intelligence Anxiety & Autonomous Agents",
    "Modern Workplace Fatigue & Asynchronous Work",
    "Digital Identity, Pseudonyms & Social Privacy",
    "Streaming Culture, Lost Media & Niche Cinema",
    "Retro Gaming, Game Engines & Microtransactions",
    "Urban Solitude, Digital Minimalism & Fast Pace",
    "Deep Space Exploration & Quantum Breakthroughs",
    "Subcultures, Forum Vernacular & Unpopular Takes",
    "Hardware Hacking, Home Servers & Open Source",
    "Monetization Of Everyday Hobbies"
]

DYNAMIC_SUBJECTS = [
    "Software Bloat", "Remote Culture", "Algorithmic Feeds", "Indie Development",
    "Digital Ownership", "Cloud Dependency", "Subscription Models", "Online Forums",
    "Speedrunning", "Synthwave Nostalgia", "Microservices", "Smart Appliances",
    "Cyber Espionage", "Pixel Art", "Ad Blockers", "Curation Algorithms"
]

DYNAMIC_PREDICATES = [
    "Is Completely Misunderstood", "Has Reached A Dead End", "Is Quietly Dying",
    "Needs A Complete Overhaul", "Is The Best Thing In Tech", "Was Better A Decade Ago",
    "Is Ruining Creative Focus", "Has Become A Total Circus", "Is Facing An Identity Crisis"
]

def normalize_text(text: str) -> str:
    clean = text.lower()
    clean = re.sub(r"[^\w\s]", "", clean)
    return re.sub(r"\s+", " ", clean).strip()

def english_title(text: str) -> str:
    return text.strip().title()

def get_existing_us_topics() -> set:
    """Supabase'de daha önce oluşturulmuş US başlıklarını çeker."""
    cached = set()
    try:
        res = supabase.table("topics").select("topic_name").eq("region", "US").execute()
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
    user_prompt = f"Create a fresh topic title about: {category} (Seed: {random.randint(1000, 9999)})"

    if groq_client:
        for model in ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]:
            try:
                chat = groq_client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    temperature=0.95
                )
                text = chat.choices[0].message.content.strip().strip('"\'')
                if text and len(text) > 3:
                    return english_title(text)
            except Exception:
                continue

    # Groq API yanıt vermezse dinamik sonsuz permutasyon üretici
    subj = random.choice(DYNAMIC_SUBJECTS)
    pred = random.choice(DYNAMIC_PREDICATES)
    return english_title(f"Why {subj} {pred}")

def save_and_run(unique_topic: str) -> bool:
    try:
        payload = {
            "topic_name": unique_topic,
            "region": "US"
        }
        res = supabase.table("topics").insert(payload).execute()
        if not res.data:
            print("✕ Başlık DB'ye eklenemedi.")
            return False

        topic_id = str(res.data[0]["topic_id"])
        print(f"✅ Yeni US başlık oluşturuldu: #{unique_topic} (topic_id: {topic_id})")

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
    existing_topics = get_existing_us_topics()

    chosen_topic = None
    # 20 defa özgün başlık türetmeyi dener
    for attempt in range(20):
        candidate = generate_topic_from_ai()
        if normalize_text(candidate) not in existing_topics:
            chosen_topic = candidate
            break

    # Havuz dolduysa asla durmaması için dinamik eklemeli başlık oluşturur
    if not chosen_topic:
        month_str = datetime.now(timezone.utc).strftime("%B %Y")
        chosen_topic = english_title(f"The State Of {random.choice(DYNAMIC_SUBJECTS)} In {month_str}")

    save_and_run(chosen_topic)
