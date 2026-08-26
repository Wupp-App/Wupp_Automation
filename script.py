import os
import re
import sys
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
    print("❌ HATA: Supabase URL veya KEY bulunamadı!")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None
scraper = cloudscraper.create_scraper()

TODAY_STR = datetime.now(timezone.utc).strftime("%Y-%m-%d")
TARGET_URLS = [
    f"https://eksisozluk.com/basliklar/tarih/{TODAY_STR}",
    "https://eksisozluk.com/basliklar/gundem",
    "https://eksisozluk.com/basliklar/populer",
    "https://eksisozluk1923.com/basliklar/gundem"
]

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "tr,tr-TR;q=0.9,en-US;q=0.8,en;q=0.7"
}

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

def get_already_saved_topics():
    try:
        response = supabase.table("weekly_topics").select("topic").execute()
        return {row["topic"].strip().lower() for row in response.data if row.get("topic")}
    except Exception as e:
        print(f"Cache kontrol hatası: {e}")
        return set()

def get_unique_topic_from_ai(topic: str) -> str:
    system_prompt = (
        "Sen popüler Türk internet forumlarının kıdemli bir yazarısın. "
        "Görevin verilen gündem başlığını anlamını bozmadan samimi ve akıcı bir Türkçe sözlük başlığına çevirmektir.\n"
        "1. Asla açıklama yapma. SADECE başlık metnini döndür.\n"
        "2. Türkçe karakterleri doğru kullan.\n"
        "3. Resmi haber dili kullanma."
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

def save_and_trigger(original_topic: str, unique_topic: str):
    try:
        # 1. Başlığı DB'ye ekle ve topic_id'yi geri al
        res = supabase.table("topics").insert({"topic_name": unique_topic}).execute()
        created_row = res.data[0] if res.data else None
        
        if not created_row:
            print("✕ Başlık oluşturuldu fakat ID alınamadı.")
            return False

        topic_id = created_row.get("topic_id")
        supabase.table("weekly_topics").insert({"topic": original_topic}).execute()
        print(f"✅ Yeni başlık DB'ye mühürlendi: #{unique_topic} (ID: {topic_id})")

        # 2. runner.ts'e sadece bu başlığı paslayarak tetikle
        print(f"\n🤖 #{unique_topic} başlığı için yorum botları başlatılıyor...")
        npm_path = shutil.which("npm") or shutil.which("npm.cmd") or "npm"
        use_shell = os.name == "nt"

        subprocess.run(
            [npm_path, "run", "bot:run", "--", str(topic_id), str(unique_topic)],
            shell=use_shell,
            check=True
        )
        return True
    except Exception as e:
        print(f"✕ İşlem hatası: {e}")
        return False

if __name__ == "__main__":
    print("🔍 Ekşi Sözlük başlıkları taranıyor...")
    raw_topics = get_data_from_target_site()

    if not raw_topics:
        print("İncelenecek başlık bulunamadı.")
        sys.exit(0)

    saved_cache = get_already_saved_topics()
    processed = False

    for topic in raw_topics:
        if topic.strip().lower() in saved_cache:
            continue

        print(f"\n📌 Yeni taze başlık yakalandı: {topic}")
        unique_topic = get_unique_topic_from_ai(topic)

        # Başlığı sadece burada açıp, runner'a gönderiyoruz
        if save_and_trigger(topic, unique_topic):
            processed = True
            break  # Saatte sadece 1 yeni başlık işlenir

    if not processed:
        print("\nℹ️ Tüm popüler başlıklar zaten eklenmiş.")
