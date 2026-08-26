import os
import re
import sys
import json
import shutil
import subprocess
from datetime import datetime, timezone
import cloudscraper
from bs4 import BeautifulSoup
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
scraper = cloudscraper.create_scraper()

TODAY_STR = datetime.now(timezone.utc).strftime("%Y-%m-%d")
CACHE_FILE = "scraped_cache.json"

TARGET_URLS = [
    f"https://eksisozluk.com/basliklar/tarih/{TODAY_STR}",
    "https://eksisozluk.com/basliklar/gundem",
    "https://eksisozluk.com/basliklar/populer"
]

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "tr,tr-TR;q=0.9,en-US;q=0.8,en;q=0.7"
}

def normalize_text(text: str) -> str:
    """Türkçe karakterleri ve noktalamaları arındırarak tekilleştirme anahtarı oluşturur."""
    tr_map = str.maketrans("İIĞÜŞÖÇâîû", "iıgüşöçaiu")
    clean = text.translate(tr_map).lower()
    clean = re.sub(r"[^\w\s]", "", clean)
    return re.sub(r"\s+", " ", clean).strip()

def turkish_title(text: str) -> str:
    upper_map = {"i": "İ", "ı": "I"}
    words = text.split()
    formatted = []
    for w in words:
        if not w:
            continue
        first_upper = upper_map.get(w[0], w[0].upper())
        formatted.append(first_upper + w[1:])
    return " ".join(formatted)

def load_scraped_cache() -> dict:
    """Ekşi Sözlük'ten çekilen başlıkların tutulduğu günlük yerel JSON cache'i yükler."""
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                # Eğer kayıt bugüne aitse cache'i döndür, dününse sıfırla
                if data.get("date") == TODAY_STR:
                    return data
        except Exception:
            pass
    return {"date": TODAY_STR, "topics": []}

def save_to_scraped_cache(raw_topic: str):
    """Çekilen orijinal Ekşi Sözlük başlığını günlük JSON dosyasına işler."""
    data = load_scraped_cache()
    norm = normalize_text(raw_topic)
    if norm not in data["topics"]:
        data["topics"].append(norm)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

def get_data_from_target_site():
    topic_list_repo = []
    for url in TARGET_URLS:
        try:
            print(f"🔗 Taranıyor: {url}")
            response = scraper.get(url, headers=headers, timeout=12)
            if response.status_code == 200:
                soup = BeautifulSoup(response.text, "html.parser")
                topic_list = soup.find("ul", class_=lambda x: x and "topic-list" in x)
                items = topic_list.find_all("li") if topic_list else soup.select("#partials li a, ul.topic-list li a")
                
                for li in items:
                    a_tag = li if li.name == "a" else li.find("a")
                    if a_tag:
                        small_tag = a_tag.find("small")
                        if small_tag:
                            small_tag.decompose()
                        raw_text = a_tag.get_text(strip=True)
                        clean_topic = re.sub(r'\s+\d+$', '', raw_text).strip()
                        if clean_topic and clean_topic not in topic_list_repo:
                            topic_list_repo.append(clean_topic)
                if topic_list_repo:
                    return topic_list_repo
        except Exception as e:
            print(f"✕ Bağlantı hatası ({url}): {e}")
    return topic_list_repo

def get_unique_topic_from_ai(topic: str) -> str:
    system_prompt = (
        "Sen popüler bir Türk sözlüğünün kıdemli yazarısın. "
        "Görevin verilen gündem konusunu, anlamını ve olayını bozmadan doğal bir Türkçe sözlük başlığına çevirmektir.\n"
        "1. Asla açıklama yapma. SADECE başlık metnini döndür.\n"
        "2. Başlığın sonuna nokta koyma, tırnak içine alma."
    )
    user_prompt = f"Şu başlığı sözlük formatında yeniden yaz: '{topic}'"
    
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
                    return turkish_title(text)
            except Exception:
                continue
    return turkish_title(topic)

def save_and_run(original_topic: str, unique_topic: str) -> bool:
    try:
        # 1. Başlığı sadece topics tablosuna ekle
        res = supabase.table("topics").insert({"topic_name": unique_topic}).execute()
        if not res.data:
            print("✕ Başlık veritabanına eklenemedi.")
            return False

        topic_id = str(res.data[0]["topic_id"])
        
        # 2. Ekşi Sözlük'ten alınan orijinal başlığı günlük JSON önbelleğe işle
        save_to_scraped_cache(original_topic)
        print(f"✅ Yeni başlık veritabanına yazıldı: #{unique_topic} (topic_id: {topic_id})")

        # 3. Yorum botlarını sadece bu başlık için tetikle
        print(f"\n🤖 #{unique_topic} için entry botları başlatılıyor...")
        npx_path = shutil.which("npx") or shutil.which("npx.cmd") or "npx"
        use_shell = os.name == "nt"

        subprocess.run(
            [npx_path, "tsx", "scripts/bot/runner.ts", topic_id, unique_topic],
            shell=use_shell,
            check=True
        )
        return True
    except Exception as e:
        print(f"✕ İşlem hatası: {e}")
        return False

if __name__ == "__main__":
    print(f"🔍 [{TODAY_STR}] Ekşi Sözlük başlıkları taranıyor...")
    raw_topics = get_data_from_target_site()

    if not raw_topics:
        print("İncelenecek başlık bulunamadı.")
        sys.exit(0)

    # Günlük çekilen Ekşi Sözlük başlıkları önbelleğini al
    cache_data = load_scraped_cache()
    cached_topics = set(cache_data.get("topics", []))
    processed = False

    for topic in raw_topics:
        norm_key = normalize_text(topic)
        # Ekşi Sözlük'ten bugün bu başlık daha önce alındıysa kesinlikle tekrar alma
        if norm_key in cached_topics:
            continue

        print(f"\n📌 Ekşi Sözlük'ten yeni taze başlık yakalandı: {topic}")
        unique_topic = get_unique_topic_from_ai(topic)

        if save_and_run(topic, unique_topic):
            processed = True
            break  # Saatte sadece 1 taze başlık işlenir

    if not processed:
        print("\nℹ️ Ekşi Sözlük'teki tüm güncel başlıklar bugün zaten çekilmiş ve önbelleğe alınmış.")
