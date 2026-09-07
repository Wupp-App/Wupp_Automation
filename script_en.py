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
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HISTORY_FILE = os.path.join(SCRIPT_DIR, "scraped_cache_en.json")

DYNAMIC_THEMES = [
    "Trending World News & Viral Internet Discourse",
    "Cutting-Edge AI Breakthroughs, Controversies & Ethics",
    "Current Workplace Culture, Layoffs, Return-to-Office & Gig Economy",
    "Current Pop Culture, Streaming Releases, Celebrity Drama & Box Office",
    "Modern Gaming Trends, Live-Service Fatigue & Industry Shifts",
    "Global Economy, Cost of Living Crises & Gen-Z Survival Strategies",
    "Social Media Algorithms, Brainrot Culture & Attention Economy",
    "Emerging Tech, Electric Vehicles, Biotech & Space Milestones",
    "Everyday Urban Dilemmas & Spicy Unpopular Opinions"
]

def normalize_text(text: str) -> str:
    clean = text.lower()
    clean = re.sub(r"[^\w\s]", "", clean)
    return re.sub(r"\s+", " ", clean).strip()

def english_title(text: str) -> str:
    return " ".join([w.capitalize() for w in text.split()])

def load_history_cache() -> set:
    """Geçmişte üretilen TÜM başlıkları kalıcı dosyadan yükler."""
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return set(data)
                elif isinstance(data, dict):
                    return set(data.get("all_time_topics", []))
        except Exception as e:
            print(f"⚠️ Geçmiş dosyası okuma uyarısı: {e}")
    return set()

def save_to_history_cache(normalized_topics: list):
    """Yeni başlıkları kalıcı geçmiş dosyasına kaydeder."""
    current_history = load_history_cache()
    current_history.update(normalized_topics)
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump({"all_time_topics": sorted(list(current_history))}, f, ensure_ascii=False, indent=2)

def get_all_db_topics() -> set:
    """Veritabanındaki US bölgesine ait tüm başlıkları çeker."""
    db_topics = set()
    try:
        res = (
            supabase.table("topics")
            .select("topic_name")
            .eq("region", "US")
            .execute()
        )
        for row in res.data or []:
            name = row.get("topic_name", "")
            if name:
                db_topics.add(normalize_text(name))
    except Exception as e:
        print(f"⚠️ DB kontrol hatası: {e}")
    return db_topics

def generate_candidate_topics(excluded_samples: list) -> list:
    """Modelden geçmişte konuşulmamış, güncel trendleri yansıtan 5 taze başlık ister."""
    candidates = []
    theme = random.choice(DYNAMIC_THEMES)
    
    past_topics_snippet = "\n".join([f"- {t}" for t in excluded_samples[-30:]]) if excluded_samples else "None"

    system_prompt = (
        "You are an active cultural curator and internet forum trend analyst. "
        "Your job is to identify high-engagement, trending, controversial, or culturally relevant discussions happening right now.\n"
        "RULES:\n"
        "1. Output ONLY the titles, separated by newlines.\n"
        "2. No numbers, no bullet points, no quotes.\n"
        "3. 2 to 7 words per title.\n"
        "4. DO NOT repeat or derive from these recently covered topics:\n"
        f"{past_topics_snippet}"
    )
    user_prompt = (
        f"Generate 5 distinct, viral-ready, or highly debated discussion topic titles in English related to: '{theme}'. "
        "Focus on current events, trending phenomena, modern societal shifts, or real-time internet debates."
    )

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
                raw_text = chat.choices[0].message.content.strip()
                lines = [re.sub(r"^\d+[\.\)]\s*", "", line).strip() for line in raw_text.split("\n") if line.strip()]
                candidates.extend([line for line in lines if line])
                if candidates:
                    break
            except Exception:
                continue

    return candidates

def format_title_with_ai(topic: str) -> str:
    system_prompt = (
        "You are an experienced forum moderator. Format and polish the given English topic title.\n"
        "1. Do NOT explain anything. Output ONLY the title.\n"
        "2. No trailing punctuation, no quotation marks."
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
                    temperature=0.6
                )
                text = chat.choices[0].message.content.strip().strip('"\'')
                if text:
                    return english_title(text)
            except Exception:
                continue
    return english_title(topic)

def ensure_bots_synced():
    try:
        res = supabase.table("profiles").select("id").eq("username", "alexmiller").maybe_single().execute()
        if not res or not res.data:
            print("⚡ İngilizce bot hesapları DB'de bulunamadı! Otomatik senkronize ediliyor...")
            npx = shutil.which("npx") or shutil.which("npx.cmd") or "npx"
            use_shell = os.name == "nt"
            init_script = os.path.join("scripts", "bot", "initBots_en.ts")
            subprocess.run([npx, "tsx", init_script], shell=use_shell, check=True)
            print("✅ İngilizce bot hesapları başarıyla oluşturuldu!\n")
    except Exception as e:
        print(f"⚠️ Bot senkronizasyon kontrolü uyarısı: {e}")

def save_and_run(unique_topic: str) -> bool:
    try:
        ensure_bots_synced()

        payload = {"topic_name": unique_topic, "region": "US"}
        res = supabase.table("topics").insert(payload).execute()
        if not res.data:
            print("✕ Başlık veritabanına eklenemedi.")
            return False

        topic_id = str(res.data[0]["topic_id"])
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
    print(f"🔍 [{TODAY_STR}] Güncel trendler ve dinamik İngilizce başlıklar taranıyor...")

    history_topics = load_history_cache()
    db_topics = get_all_db_topics()
    all_seen_topics = history_topics | db_topics

    found_unique_topic = None
    max_retries = 5

    for attempt in range(1, max_retries + 1):
        print(f"🔄 Deneme {attempt}/{max_retries}: Taze başlık adayları üretiliyor...")
        candidates = generate_candidate_topics(list(all_seen_topics))

        for candidate in candidates:
            norm_cand = normalize_text(candidate)
            if norm_cand in all_seen_topics:
                continue

            formatted = format_title_with_ai(candidate)
            norm_formatted = normalize_text(formatted)

            if norm_formatted in all_seen_topics:
                all_seen_topics.add(norm_formatted)
                continue

            # Tamamen benzersiz taze başlık yakalandı
            found_unique_topic = formatted
            all_seen_topics.add(norm_cand)
            all_seen_topics.add(norm_formatted)
            save_to_history_cache([norm_cand, norm_formatted])
            break

        if found_unique_topic:
            break

    if not found_unique_topic:
        print("❌ Benzersiz ve yeni bir başlık üretilemedi. Daha sonra tekrar deneyin.")
        sys.exit(1)

    print(f"\n📌 İşlenecek Taze Başlık Seçildi: #{found_unique_topic}")
    success = save_and_run(found_unique_topic)

    if not success:
        print("⚠️ Başlık kaydedilemedi veya bot koşumu başarısız oldu.")
