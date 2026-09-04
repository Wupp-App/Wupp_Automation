import os
import sys
import time
import shutil
import subprocess
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
    "Artificial Intelligence & Tech Layoffs",
    "Modern Workplace & Asynchronous Work",
    "Social Media Brainrot & Short-form Content",
    "Gaming Industry & Indie Game Renaissance",
    "Cybersecurity & Digital Surveillance",
    "Modern Philosophy, Stoicism & Urban Solitude",
    "Cinema, Forgotten Cult Classics & TV Streaming",
    "Consumer Electronics & Built-in Obsolescence"
]

def generate_english_topic() -> str:
    timestamp_seed = int(time.time() * 1000)
    category = CATEGORIES[timestamp_seed % len(CATEGORIES)]
    
    system_prompt = (
        "You are an active curator of a global internet forum/dictionary (like Reddit or Urban Dictionary). "
        "Generate ONE catchy, provocative, discussion-sparking topic title in English.\n"
        "RULES:\n"
        "1. Output ONLY the topic title text. No quotes, no markdown, no punctuation at the end.\n"
        "2. Between 2 to 6 words.\n"
        "3. Title Case format."
    )
    user_prompt = f"Create a fresh, unique topic about: {category}. Unique seed: {timestamp_seed}"

    if groq_client:
        for model in ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]:
            try:
                chat = groq_client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    temperature=0.9
                )
                text = chat.choices[0].message.content.strip().strip('"\'')
                if text and len(text) > 3:
                    return text.title()
            except Exception as e:
                print(f"⚠️ Groq hatası ({model}): {e}")
                continue

    # API erişilemezse asla patlamayan benzersiz zaman damgalı fallback
    return f"The Reality Of {category.split('&')[0].strip()} #{timestamp_seed % 1000}"

def run():
    print("🌍 Yeni İngilizce başlık üretiliyor...")
    topic_title = generate_english_topic()
    print(f"🎯 Üretilen başlık: {topic_title}")

    # topics tablosuna ekle
    payload = {
        "topic_name": topic_title,
        "region": "US"
    }
    res = supabase.table("topics").insert(payload).execute()
    
    if not res.data:
        print("❌ Başlık Supabase'e eklenemedi!")
        sys.exit(1)

    topic_id = str(res.data[0]["topic_id"])
    print(f"✅ Başlık eklendi: #{topic_title} (topic_id: {topic_id})")

    # runner_en.ts dosyasını tetikle
    runner_path = os.path.join("scripts", "bot", "runner_en.ts")
    if not os.path.exists(runner_path):
        runner_path = "runner_en.ts"

    npx_path = shutil.which("npx") or shutil.which("npx.cmd") or "npx"
    use_shell = os.name == "nt"

    print(f"\n🤖 #{topic_title} için entry botları başlatılıyor...\n")
    subprocess.run(
        [npx_path, "tsx", runner_path, topic_id, topic_title],
        shell=use_shell,
        check=True
    )

if __name__ == "__main__":
    run()
