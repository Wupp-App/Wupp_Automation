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
    "Artificial Intelligence & Autonomous Systems",
    "Modern Remote Workplace Realities",
    "Digital Minimalism & Social Feeds",
    "Indie Game Development & Retro Consoles",
    "Cybersecurity Threats & Digital Privacy",
    "Modern Philosophy, Fast Living & Burnout",
    "Cinema Classics, Hidden Gems & Television",
    "Consumer Hardware Quirks & Smart Devices"
]

def generate_english_topic() -> str:
    timestamp_seed = int(time.time() * 1000)
    category = CATEGORIES[timestamp_seed % len(CATEGORIES)]

    system_prompt = (
        "You are an active curator of an international discussion forum and urban dictionary. "
        "Create ONE engaging, debate-worthy, fresh topic title in English.\n"
        "RULES:\n"
        "1. Output ONLY the title text. No quotation marks, no ending period, no bullet points.\n"
        "2. Between 2 to 6 words.\n"
        "3. Standard Title Case."
    )
    user_prompt = f"Topic area: {category}. Unique seed: {timestamp_seed}"

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

    fallback_topics = [
        "The Quiet Death Of Pure Online Privacy",
        "Why Modern Gaming Sequels Keep Disappointing",
        "Remote Work Is Killing Natural Spontaneity",
        "The Illusion Of Modern Digital Detox",
        "Algorithmic Fatigue On Modern Social Feeds"
    ]
    return f"{fallback_topics[timestamp_seed % len(fallback_topics)]} #{timestamp_seed % 1000}"

def main():
    print("🌍 Yeni İngilizce başlık üretimi başlatılıyor...")
    topic_title = generate_english_topic()
    print(f"🎯 Belirlenen başlık: {topic_title}")

    payload = {
        "topic_name": topic_title,
        "region": "US"
    }

    res = supabase.table("topics").insert(payload).execute()
    if not res.data:
        print("❌ Başlık Supabase'e eklenemedi!")
        sys.exit(1)

    topic_id = str(res.data[0]["topic_id"])
    print(f"✅ Yeni US başlık eklendi: #{topic_title} (topic_id: {topic_id})")

    # Dosya yolu kontrolü
    script_dir = os.path.dirname(os.path.abspath(__file__))
    runner_path = os.path.join(script_dir, "scripts", "bot", "runner_en.ts")
    if not os.path.exists(runner_path):
        runner_path = os.path.join(os.getcwd(), "scripts", "bot", "runner_en.ts")
    if not os.path.exists(runner_path):
        runner_path = "scripts/bot/runner_en.ts"

    npx_path = shutil.which("npx") or shutil.which("npx.cmd") or "npx"
    use_shell = os.name == "nt"

    print(f"\n🤖 #{topic_title} için EN entry botları tetikleniyor...")
    subprocess.run(
        [npx_path, "tsx", runner_path, topic_id, topic_title],
        shell=use_shell,
        check=True
    )

if __name__ == "__main__":
    main()
