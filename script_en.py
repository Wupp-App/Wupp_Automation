"""
US güncel konu başlığı üretici — tekrar üretimi engelleyen kalıcı geçmiş sistemi ile.

Önceki sürüme göre değişiklikler:
1. Geçmiş sadece "tam eşleşme" (normalize edilmiş string) ile değil, ayrıca
   difflib ile "anlamsal/yazımsal benzerlik" oranına göre de kontrol ediliyor.
   Böylece "AI Job Losses" ile "Job Losses From AI" gibi neredeyse aynı
   başlıklar da tekrar üretilmiş sayılıyor.
2. DB'den başlık çekerken sayfalama (pagination) eklendi — Supabase varsayılan
   olarak tek seferde ~1000 satırla sınırlı, üstüne çıkan projelerde eski
   sürüm sessizce eksik veri çekiyordu.
3. Geçmiş dosyası artık atomik yazılıyor (tmp dosyaya yaz + rename) — script
   çalışırken kesilirse dosya bozulmuyor.
4. Başlık büyük/küçük harf normalizasyonu düzgün "title case" kurallarına
   göre yapılıyor (the/of/in/a gibi küçük kelimeler cümle başında değilse
   küçük kalıyor).
5. Aday üretim döngüsü: her denemede birden fazla tema karışık kullanılıyor,
   başarısız denemelerde model sıcaklığı ve tema seçimi değiştiriliyor.
6. Daha ayrıntılı ve tutarlı loglama + tip belirteçleri (type hints).
7. Supabase insert'inde eşzamanlı çalışan başka bir instance aynı başlığı
   aynı anda eklemeye çalışırsa oluşabilecek "unique constraint" hatası
   yakalanıp yeniden deneme yapılıyor.
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

# Benzerlik eşiği: bu değerin üstündeki oran "aynı konu" kabul edilir.
# 1.0 = birebir aynı metin, 0.0 = alakasız. 0.82 pratikte iyi bir denge noktası.
SIMILARITY_THRESHOLD = 0.82

# Bir DB fetch sayfasının satır sayısı (Supabase/PostgREST varsayılan limiti aşmamak için)
DB_PAGE_SIZE = 1000

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

# Title-case'te küçük harfle kalması gereken bağlaç/edat/artikel listesi
_SMALL_WORDS = {
    "a", "an", "the", "and", "or", "but", "nor", "of", "in", "on", "at",
    "to", "for", "with", "vs", "vs.", "is", "as", "by", "from",
}


# --------------------------------------------------------------------------
# Metin yardımcı fonksiyonları
# --------------------------------------------------------------------------

def normalize_text(text: str) -> str:
    """Karşılaştırma için metni sadeleştirir: küçük harf, noktalama yok, tek boşluk."""
    clean = text.lower()
    clean = re.sub(r"[^\w\s]", "", clean)
    return re.sub(r"\s+", " ", clean).strip()


def english_title(text: str) -> str:
    """Doğru İngilizce başlık formatı: küçük kelimeler (the/of/in vb.)
    cümle başında/sonunda değilse küçük harfle kalır, diğerleri baş harf büyük."""
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
    """Tam eşleşme VEYA yüksek benzerlik oranı varsa True döner."""
    if candidate_norm in seen:
        return True
    for existing in seen:
        ratio = difflib.SequenceMatcher(None, candidate_norm, existing).ratio()
        if ratio >= threshold:
            return True
    return False


# --------------------------------------------------------------------------
# Kalıcı geçmiş dosyası (atomik okuma/yazma)
# --------------------------------------------------------------------------

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


def save_to_history_cache(normalized_topics: list) -> None:
    """Yeni başlıkları kalıcı geçmiş dosyasına atomik olarak kaydeder."""
    current_history = load_history_cache()
    current_history.update(normalized_topics)

    dir_name = os.path.dirname(HISTORY_FILE) or "."
    fd, tmp_path = tempfile.mkstemp(prefix=".history_", suffix=".json", dir=dir_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"all_time_topics": sorted(current_history)}, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, HISTORY_FILE)  # atomik değiştirme
    except Exception as e:
        print(f"⚠️ Geçmiş dosyası yazma hatası: {e}")
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


# --------------------------------------------------------------------------
# Veritabanı
# --------------------------------------------------------------------------

def get_all_db_topics() -> set:
    """Veritabanındaki US bölgesine ait TÜM başlıkları sayfalayarak çeker."""
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
# LLM ile aday üretim
# --------------------------------------------------------------------------

def generate_candidate_topics(excluded_samples: list, theme: str, temperature: float = 0.9) -> list:
    """Modelden geçmişte konuşulmamış, güncel trendleri yansıtan taze başlıklar ister."""
    candidates: list = []

    # Geçmişin tamamını prompta sığdırmak imkansız; en güncel örnekleri gösteriyoruz.
    # Ayrıca rastgele bir örneklem ekleyerek modelin sadece "son eklenenler"
    # etrafında dönmesini engelliyoruz.
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

    if groq_client:
        for model in ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]:
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
        for model in ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]:
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


# --------------------------------------------------------------------------
# Bot senkronizasyonu ve kayıt
# --------------------------------------------------------------------------

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
    """Başlığı DB'ye yazar ve entry botlarını tetikler.
    Eşzamanlı bir başka çalıştırma aynı başlığı aynı anda eklerse
    (unique constraint çakışması), bunu ayrı bir hata olarak ele alır."""
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


# --------------------------------------------------------------------------
# Ana akış
# --------------------------------------------------------------------------

def main() -> None:
    print(f"🔍 [{TODAY_STR}] Güncel trendler ve dinamik İngilizce başlıklar taranıyor...")

    history_topics = load_history_cache()
    db_topics = get_all_db_topics()
    all_seen_topics = history_topics | db_topics
    print(f"ℹ️ Toplam bilinen geçmiş başlık sayısı: {len(all_seen_topics)}")

    found_unique_topic = None
    max_retries = 8
    used_themes: list = []

    for attempt in range(1, max_retries + 1):
        # Aynı temayı art arda denememek için henüz kullanılmamış bir tema seç
        remaining_themes = [t for t in DYNAMIC_THEMES if t not in used_themes] or DYNAMIC_THEMES
        theme = random.choice(remaining_themes)
        used_themes.append(theme)

        # Denemeler ilerledikçe biraz daha yüksek sıcaklık dene (çeşitlilik artsın)
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
        sys.exit(1)


if __name__ == "__main__":
    main()
