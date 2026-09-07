"""
US güncel konu başlığı üretici — Multi-Provider (Gemini + Groq + OpenAI) Failover Engine.
Groq modelleri çökerse otomatik olarak Google Gemini'ye, o da olmazsa OpenAI'a geçer.
"""

import os
import re
import sys
import json
import random
import shutil
import difflib
import tempfile
import subprocess
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Iterable, List, Optional

from groq import Groq
from supabase import create_client, Client

print("🚀 ÇOKLU SAĞLAYICI MOTORU BAŞLATILDI (Gemini / Groq / OpenAI Fallback)")

# --------------------------------------------------------------------------
# Ortam değişkenleri & İstemciler
# --------------------------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("❌ HATA: Supabase URL veya KEY eksik!")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

TODAY_STR = datetime.now(timezone.utc).strftime("%Y-%m-%d")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HISTORY_FILE = os.path.join(SCRIPT_DIR, "scraped_cache_en.json")

SIMILARITY_THRESHOLD = 0.82
DB_PAGE_SIZE = 1000

# --------------------------------------------------------------------------
# Model Listeleri
# --------------------------------------------------------------------------

GEMINI_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
]

GROQ_FALLBACK_MODELS = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "gemma2-9b-it",
    "mixtral-8x7b-32768",
]

DYNAMIC_THEMES = [
    "Trending World News & Viral Internet Discourse",
    "Cutting-Edge AI Breakthroughs, Controversies & Ethics",
    "Current Workplace Culture, Layoffs, Return-to-Office & Gig Economy",
    "Current Pop Culture, Streaming Releases, Celebrity Drama & Box Office",
    "Modern Gaming Trends, Live-Service Fatigue & Industry Shifts",
    "Global Economy, Cost of Living Crises & Gen-Z Survival Strategies",
    "Social Media Algorithms, Brainrot Culture & Attention Economy",
    "Emerging Tech, Electric Vehicles, Biotech & Space Milestones",
    "Everyday Urban Dilemmas & Spicy Unpopular Opinions",
]

_SMALL_WORDS = {
    "a", "an", "the", "and", "or", "but", "nor", "of", "in", "on", "at",
    "to", "for", "with", "vs", "vs.", "is", "as", "by", "from",
}

# --------------------------------------------------------------------------
# Multi-Provider AI Çağrı Fonksiyonları
# --------------------------------------------------------------------------

def call_gemini_api(model: str, system_prompt: str, user_prompt: str, temperature: float = 0.7) -> Optional[str]:
    """Gemini REST API'sini doğrudan HTTP ile çağırır (Ek kütüphane gerektirmez)."""
    if not GEMINI_API_KEY:
        return None
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}"
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"parts": [{"text": user_prompt}]}],
        "generationConfig": {"temperature": temperature, "maxOutputTokens": 800}
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            res_data = json.loads(response.read().decode("utf-8"))
            return res_data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception as e:
        print(f"⚠️ Gemini API hatası ({model}): {e}")
        return None


def call_groq_api(model: str, system_prompt: str, user_prompt: str, temperature: float = 0.7) -> Optional[str]:
    """Groq API üzerinden çağrı yapar."""
    if not groq_client:
        return None
    try:
        chat = groq_client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
        )
        return chat.choices[0].message.content.strip()
    except Exception as e:
        print(f"⚠️ Groq API hatası ({model}): {e}")
        return None


def call_openai_api(system_prompt: str, user_prompt: str, temperature: float = 0.7) -> Optional[str]:
    """OpenAI API üzerinden çağrı yapar (opsiyonel son çare)."""
    if not OPENAI_API_KEY:
        return None
    url = "https://api.openai.com/v1/chat/completions"
    payload = {
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "temperature": temperature
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENAI_API_KEY}"
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            res_data = json.loads(response.read().decode("utf-8"))
            return res_data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"⚠️ OpenAI API hatası: {e}")
        return None


def execute_llm_chain(system_prompt: str, user_prompt: str, temperature: float = 0.7) -> Optional[str]:
    """Sırasıyla Gemini, Groq ve OpenAI'ı dener; ilk başarılı olanın sonucunu döner."""
    # 1. Aşama: Google Gemini Modelleri
    if GEMINI_API_KEY:
        for model in GEMINI_MODELS:
            res = call_gemini_api(model, system_prompt, user_prompt, temperature)
            if res:
                return res

    # 2. Aşama: Groq Modelleri
    if GROQ_API_KEY:
        for model in GROQ_FALLBACK_MODELS:
            res = call_groq_api(model, system_prompt, user_prompt, temperature)
            if res:
                return res

    # 3. Aşama: OpenAI
    if OPENAI_API_KEY:
        res = call_openai_api(system_prompt, user_prompt, temperature)
        if res:
            return res

    return None

# --------------------------------------------------------------------------
# Metin Temizleme ve Benzerlik Kontrolleri
# --------------------------------------------------------------------------

def normalize_text(text: str) -> str:
    clean = text.lower()
    clean = re.sub(r"[^\w\s]", "", clean)
    return re.sub(r"\s+", " ", clean).strip()


def english_title(text: str) -> str:
    words = text.split()
    if not words:
        return text
    result = []
    last_idx = len(words) - 1
    for i, w in enumerate(words):
        lw = w.lower()
        if 0 < i < last_idx and lw in _SMALL_WORDS:
            result.append(lw)
        else:
            result.append(lw.capitalize())
    return " ".join(result)


def is_duplicate(candidate_norm: str, seen: Iterable[str], threshold: float = SIMILARITY_THRESHOLD) -> bool:
    if candidate_norm in seen:
        return True
    for existing in seen:
        ratio = difflib.SequenceMatcher(None, candidate_norm, existing).ratio()
        if ratio >= threshold:
            return True
    return False


def load_history_cache() -> set:
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


def save_to_history_cache(normalized_topics: list) -> None:
    current_history = load_history_cache()
    current_history.update(normalized_topics)

    dir_name = os.path.dirname(HISTORY_FILE) or "."
    fd, tmp_path = tempfile.mkstemp(prefix=".history_", suffix=".json", dir=dir_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"all_time_topics": sorted(current_history)}, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, HISTORY_FILE)
    except Exception as e:
        print(f"⚠️ Geçmiş dosyası yazma hatası: {e}")
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def get_all_db_topics() -> set:
    db_topics = set()
    offset = 0
    try:
        while True:
            res = (
                supabase.table("topics")
                .select("topic_name")
                .eq("region", "US")
                .range(offset, offset + DB_PAGE_SIZE - 1)
                .execute()
            )
            rows = res.data or []
            for row in rows:
                name = row.get("topic_name", "")
                if name:
                    db_topics.add(normalize_text(name))
            if len(rows) < DB_PAGE_SIZE:
                break
            offset += DB_PAGE_SIZE
    except Exception as e:
        print(f"⚠️ DB kontrol hatası: {e}")
    return db_topics

# --------------------------------------------------------------------------
# Aday Başlık Üretimi & Formatlama
# --------------------------------------------------------------------------

def generate_candidate_topics(excluded_samples: list, theme: str, temperature: float = 0.9) -> list:
    recent = excluded_samples[-40:]
    older_sample = random.sample(excluded_samples[:-40], min(20, max(0, len(excluded_samples) - 40))) \
        if len(excluded_samples) > 40 else []
    past_topics_snippet = "\n".join(f"- {t}" for t in (recent + older_sample)) or "None"

    system_prompt = (
        "You are an active cultural curator and internet forum trend analyst. "
        "Your job is to identify high-engagement, trending, controversial, or culturally relevant discussions happening right now.\n"
        "RULES:\n"
        "1. Output ONLY the titles, separated by newlines.\n"
        "2. No numbers, no bullet points, no quotes.\n"
        "3. 2 to 7 words per title.\n"
        "4. Titles must be genuinely distinct from each other (not rewordings of the same idea).\n"
        "5. DO NOT repeat, rephrase, or closely derive from these recently covered topics:\n"
        f"{past_topics_snippet}"
    )
    user_prompt = (
        f"Generate 6 distinct, viral-ready, or highly debated discussion topic titles in English related to: '{theme}'. "
        "Focus on current events, trending phenomena, modern societal shifts, or real-time internet debates."
    )

    raw_text = execute_llm_chain(system_prompt, user_prompt, temperature)
    if not raw_text:
        return []

    lines = [re.sub(r"^\d+[\.\)]\s*", "", line).strip() for line in raw_text.split("\n") if line.strip()]
    return [line for line in lines if line]


def format_title_with_ai(topic: str) -> str:
    system_prompt = (
        "You are an experienced forum moderator. Format and polish the given English topic title.\n"
        "1. Do NOT explain anything. Output ONLY the title.\n"
        "2. No trailing punctuation, no quotation marks."
    )
    user_prompt = f"Format this topic: '{topic}'"

    formatted_text = execute_llm_chain(system_prompt, user_prompt, temperature=0.5)
    if formatted_text:
        clean = formatted_text.strip().strip("\"'")
        return english_title(clean)
    return english_title(topic)


def ensure_bots_synced() -> None:
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
        try:
            res = supabase.table("topics").insert(payload).execute()
        except Exception as e:
            msg = str(e).lower()
            if "duplicate" in msg or "unique" in msg or "conflict" in msg:
                print(f"⚠️ Başlık başka bir çalıştırma tarafından az önce eklenmiş görünüyor: {unique_topic}")
                return False
            raise

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
            check=True,
        )
        return True
    except Exception as e:
        print(f"✕ İşlem hatası: {e}")
        return False


def main() -> None:
    print(f"🔍 [{TODAY_STR}] Güncel trendler taranıyor...")
    
    # Hangi anahtarların mevcut olduğunu kontrol et
    available_providers = []
    if GEMINI_API_KEY: available_providers.append("Google Gemini")
    if GROQ_API_KEY: available_providers.append("Groq")
    if OPENAI_API_KEY: available_providers.append("OpenAI")
    
    print(f"ℹ️ Aktif AI Sağlayıcıları: {', '.join(available_providers) if available_providers else 'Hiçbiri bulunamadı!'}")

    if not available_providers:
        print("❌ HATA: GEMINI_API_KEY veya GROQ_API_KEY ortam değişkeni tanımlı değil!")
        sys.exit(1)

    history_topics = load_history_cache()
    db_topics = get_all_db_topics()
    all_seen_topics = history_topics | db_topics
    print(f"ℹ️ Toplam bilinen geçmiş başlık sayısı: {len(all_seen_topics)}")

    found_unique_topic = None
    max_retries = 8
    used_themes: list = []

    for attempt in range(1, max_retries + 1):
        remaining_themes = [t for t in DYNAMIC_THEMES if t not in used_themes] or DYNAMIC_THEMES
        theme = random.choice(remaining_themes)
        used_themes.append(theme)

        temperature = min(0.6 + attempt * 0.05, 1.0)
        print(f"🔄 Deneme {attempt}/{max_retries}: '{theme}' teması işleniyor (t={temperature:.2f})...")
        
        candidates = generate_candidate_topics(list(all_seen_topics), theme, temperature)

        if not candidates:
            print("  ↳ Hiçbir AI sağlayıcısı aday üretemedi, sonraki denemeye geçiliyor.")
            continue

        for candidate in candidates:
            norm_cand = normalize_text(candidate)
            if not norm_cand or is_duplicate(norm_cand, all_seen_topics):
                continue

            formatted = format_title_with_ai(candidate)
            norm_formatted = normalize_text(formatted)

            if is_duplicate(norm_formatted, all_seen_topics):
                all_seen_topics.add(norm_formatted)
                continue

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
        sys.exit(1)


if __name__ == "__main__":
    main()
