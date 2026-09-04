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

TODAY_STR = datetime.now(timezone.utc).strftime("%Y-%m-%d")

# Cache dosyasını script'in bulunduğu klasöre sabitliyoruz
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(SCRIPT_DIR, "scraped_cache_en.json")

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
    """Noktalama işaretlerini arındırarak tekilleştirme anahtarı oluşturur."""
    clean = text.lower()
    clean = re.sub(r"[^\w\s]", "", clean)
    return re.sub(r"\s+", " ", clean).strip()


def english_title(text: str) -> str:
    """İngilizce başlık formatına (Title Case) çevirir."""
    return " ".join([w.capitalize() for w in text.split()])


def load_scraped_cache() -> dict:
    """İngilizce başlıkların tutulduğu günlük yerel JSON cache'i yükler."""
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("date") == TODAY_STR:
                    return data
        except Exception:
            pass
    return {"date": TODAY_STR, "topics": []}


def save_to_scraped_cache(raw_topic: str):
    """Üretilen İngilizce başlığı günlük JSON dosyasına işler."""
    data = load_scraped_cache()
    norm = normalize_text(raw_topic)
    if norm not in data["topics"]:
        data["topics"].append(norm)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


def get_today_topics_from_db() -> set:
    """
    Supabase'deki 'topics' tablosunda bugün eklenmiş US bölgesindeki
    başlıkları çekip normalize edilmiş set olarak döner.
    """
    db_topics = set()
    try:
        start_of_day = f"{TODAY_STR}T00:00:00+00:00"
        res = (
            supabase.table("topics")
            .select("topic_name, created_at")
            .eq("region", "US")
            .gte("created_at", start_of_day)
            .execute()
        )
        for row in res.data or []:
            name = row.get("topic_name", "")
            if name:
                db_topics.add(normalize_text(name))
    except Exception as e:
        print(f"⚠️ DB'den bugünkü US başlıkları çekilemedi (sadece local cache kullanılacak): {e}")
    return db_topics


def generate_candidate_topics() -> list:
    """
    Ekşi Sözlük yerine Groq API ile tartışmaya açık 5 adet taze
    İngilizce başlık adayı türetir.
    """
    candidates = []
    category = random.choice(CATEGORIES)
    
    system_prompt = (
        "You are an active curator for an international urban discussion board (like Reddit, Hacker News, or Urban Dictionary). "
        "Generate 5 distinct, catchy, discussion-worthy topic titles in English.\n"
        "RULES:\n"
        "1. Output ONLY the titles, separated by newlines.\n"
        "2. No numbers, no bullet points, no quotation marks.\n"
        "3. 2 to 7 words per title."
    )
    user_prompt = f"Generate 5 engaging topic titles about: {category}"

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
                raw_text = chat.choices[0].message.content.strip()
                lines = [re.sub(r"^\d+[\.\)]\s*", "", line).strip() for line in raw_text.split("\n") if line.strip()]
                candidates.extend([line for line in lines if line])
                if candidates:
                    break
            except Exception:
                continue

    # Fallback havuzu
    if not candidates:
        candidates = [
            "The Illusion Of Modern Digital Detox",
            "Why Video Game Sequels Keep Disappointing",
            "The Silent Death Of True Online Privacy",
            "Working Remotely Is Ruining Spontaneity",
            "Overrated Masterpieces In Modern Cinema"
        ]
    return candidates


def get_unique_topic_from_ai(topic: str) -> str:
    """Başlığı standart sözlük formatına çeker."""
    system_prompt = (
        "You are an experienced forum/dictionary moderator. "
        "Format and polish the given English topic title into a clean, provocative forum title.\n"
        "1. Do NOT explain anything. Output ONLY the title.\n"
        "2. No trailing punctuation, no quotation marks.\n"
        "3. Keep it brief and natural."
    )
    user_prompt = f"Format this topic: '{topic}'"

    if groq_client:
        for model in ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]:
            try:
                chat = groq_client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    temperature=0.7
                )
                text = chat.choices[0].message.content.strip().strip('"\'')
                if text:
                    return english_title(text)
            except Exception:
                continue
    return english_title(topic)


def save_and_run(original_topic: str, unique_topic: str) -> bool:
    try:
        # topics tablosuna region: 'US' olarak ekleme yapıyoruz
        payload = {
            "topic_name": unique_topic,
            "region": "US"
        }
        res = supabase.table("topics").insert(payload).execute()
        if not res.data:
            print("✕ Başlık veritabanına eklenemedi.")
            return False

        topic_id = str(res.data[0]["topic_id"])

        save_to_scraped_cache(original_topic)
        print(f"✅ Yeni US başlık veritabanına yazıldı: #{unique_topic} (topic_id: {topic_id})")

        print(f"\n🤖 #{unique_topic} için EN entry botları başlatılıyor...")
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
    print(f"🔍 [{TODAY_STR}] İngilizce başlık adayları taranıyor...")
    raw_topics = generate_candidate_topics()

    if not raw_topics:
        print("İncelenecek başlık bulunamadı.")
        sys.exit(0)

    # Yerel cache + veritabanındaki bugünkü US başlıkları birleştir
    cache_data = load_scraped_cache()
    cached_topics = set(cache_data.get("topics", []))
    db_topics = get_today_topics_from_db()
    all_seen_topics = cached_topics | db_topics

    processed = False

    for topic in raw_topics:
        norm_key = normalize_text(topic)
        if norm_key in all_seen_topics:
            continue

        print(f"\n📌 Yeni taze başlık adayı yakalandı: {topic}")
        unique_topic = get_unique_topic_from_ai(topic)

        if normalize_text(unique_topic) in all_seen_topics:
            save_to_scraped_cache(topic)
            continue

        if save_and_run(topic, unique_topic):
            processed = True
            break  # Döngü başına sadece 1 taze başlık işlenir

    if not processed:
        print("\nℹ️ Üretilen tüm güncel başlıklar bugün zaten işlenmiş ve önbelleğe alınmış.")
