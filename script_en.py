import os
import sys
import json
import random
import shutil
import subprocess
from groq import Groq
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("❌ HATA: Supabase bağlantı değişkenleri eksik!")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

CATEGORIES = [
    "Technology & AI Innovations",
    "Global Remote Work Culture & Tech Layoffs",
    "Cybersecurity Threats & Digital Privacy",
    "Space Exploration & Astronomy",
    "Modern Philosophy, Stoicism & Fast Paced Life",
    "Gaming Industry & Indie Game Trends",
    "Cinema, Pop Culture & Hidden Gem TV Series",
    "Electric Vehicles & Renewable Energy"
]

def generate_english_topic() -> str:
    category = random.choice(CATEGORIES)
    system_prompt = (
        "You are a creative curator for an international urban dictionary and internet discussion platform (like Reddit or Urban Dictionary). "
        "Generate ONE catchy, insightful, and discussion-worthy topic title in English.\n"
        "RULES:\n"
        "1. Do not use quotes, punctuation at the end, or numbering.\n"
        "2. Output ONLY the topic title.\n"
        "3. Keep it between 2 to 7 words.\n"
        "4. Title Case format."
    )
    user_prompt = f"Generate an engaging topic title about: {category}"

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
                title = chat.choices[0].message.content.strip().strip('"\'')
                if title:
                    return title.title()
            except Exception:
                continue

    fallbacks = [
        "The Illusion Of Digital Minimalism",
        "Why Modern Video Games Feel Soulless",
        "Remote Work Burnout In Tech",
        "Open Source AI Versus Big Tech",
        "The Decline Of Traditional Social Media"
    ]
    return random.choice(fallbacks)

def check_topic_exists(topic_name: str) -> bool:
    try:
        res = supabase.table("topics").select("topic_id").eq("topic_name", topic_name).execute()
        return len(res.data) > 0
    except Exception as e:
        print(f"Kontrol hatası: {e}")
        return False

def save_and_trigger(topic_name: str):
    try:
        # topics tablosunda İngilizce olduğunu belirten 'en' sütunu (boolean veya text 'en') işaretlenir
        insert_payload = {
            "topic_name": topic_name,
            "en": True  # Eğer veritabanında 'en' sütunun text ise "en" yazabilirsin
        }
        res = supabase.table("topics").insert(insert_payload).execute()
        if not res.data:
            print("✕ Başlık DB'ye eklenemedi.")
            return

        topic_id = str(res.data[0]["topic_id"])
        print(f"✅ Yeni İngilizce başlık oluşturuldu: #{topic_name} (topic_id: {topic_id})")

        # runner_en.ts scriptini çalıştırarak 10-20 rastgele entry yazdır
        npx_path = shutil.which("npx") or shutil.which("npx.cmd") or "npx"
        use_shell = os.name == "nt"
        
        subprocess.run(
            [npx_path, "tsx", "scripts/bot/runner_en.ts", topic_id, topic_name],
            shell=use_shell,
            check=True
        )
    except Exception as e:
        print(f"✕ Kayıt veya çalıştırma hatası: {e}")

if __name__ == "__main__":
    print("🌍 Yeni İngilizce başlık üretiliyor...")
    candidate_topic = None
    for _ in range(5):
        generated = generate_english_topic()
        if not check_topic_exists(generated):
            candidate_topic = generated
            break

    if candidate_topic:
        save_and_trigger(candidate_topic)
    else:
        print("Mükerrer olmayan başlık türetilemedi, bir sonraki döngüde denenecek.")
