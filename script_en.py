"""
US güncel konu başlığı üretici — tekrar üretimi engelleyen kalıcı geçmiş sistemi ile.

ÖNEMLİ: Groq, llama-3.3-70b-versatile ve llama-3.1-8b-instant modellerini
16 Ağustos 2026'da decommission etti (404 model_not_found hatası veriyorlar).
Bu sürümde model isimleri SABİT olarak openai/gpt-oss-120b ve openai/gpt-oss-20b
olarak yazılmıştır — env değişkeni override YOKTUR, bu yüzden ortamda unutulmuş
eski bir env var bu modelleri tekrar bozamaz.
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
from datetime import datetime, timezone
from typing import Iterable

from groq import Groq
from supabase import create_client, Client

# --------------------------------------------------------------------------
# Ortam değişkenleri / istemciler
# --------------------------------------------------------------------------

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

SIMILARITY_THRESHOLD = 0.82
DB_PAGE_SIZE = 1000

# --------------------------------------------------------------------------
# Groq model listesi — SABİT, env override yok (bilinçli tercih)
# --------------------------------------------------------------------------
GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]

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


def generate_candidate_topics(excluded_samples: list, theme: str, temperature: float = 0.9) -> list:
    candidates: list = []

    if not groq_client:
        print("  ↳ ⚠️ GROQ_API_KEY tanımlı değil, model çağrısı atlanıyor.")
        return candidates

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

    for model in GROQ_MODELS:
        try:
            chat = groq_client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=temperature,
            )
            raw_text = chat.choices[0].message.content.strip()
            lines = [re.sub(r"^\d+[\.\)]\s*", "", line).strip() for line in raw_text.split("\n") if line.strip()]
            candidates.extend([line for line in lines if line])
            if candidates:
                break
        except Exception as e:
            print(f"⚠️ Groq üretim hatası ({model}): {e}")
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
        for model in GROQ_MODELS:
            try:
                chat = groq_client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    temperature=0.6,
                )
                text = chat.choices[0].message.content.strip().strip("\"'")
                if text:
                    return english_title(text)
            except Exception as e:
                print(f"⚠️ Groq format hatası ({model}): {e}")
                continue
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
    print(f"🔍 [{TODAY_STR}] Güncel trendler ve dinamik İngilizce başlıklar taranıyor...")
    print(f"ℹ️ Kullanılacak Groq modelleri (sabit, sırayla): {GROQ_MODELS}")

    if not groq_client:
        print("❌ HATA: GROQ_API_KEY tanımlı değil, başlık üretilemez.")
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

        print(f"🔄 Deneme {attempt}/{max_retries}: '{theme}' teması için taze başlık adayları üretiliyor (t={temperature:.2f})...")
        candidates = generate_candidate_topics(list(all_seen_topics), theme, temperature)

        if not candidates:
            print("  ↳ Model aday üretemedi, sonraki denemeye geçiliyor.")
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
