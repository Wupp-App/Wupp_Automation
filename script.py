import os
import time
import subprocess
import shutil
import cloudscraper
from bs4 import BeautifulSoup
from groq import Groq
from supabase import create_client, Client
from datetime import datetime, timezone

supabase_url = os.environ.get("SUPABASE_URL")
supabase_key = os.environ.get("SUPABASE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

supabase: Client = create_client(supabase_url, supabase_key)
client = Groq(api_key=GROQ_API_KEY)

scraper = cloudscraper.create_scraper()

# Günün tarihli akış URL'si ve güncel akışlar
TODAY_STR = datetime.now(timezone.utc).strftime("%Y-%m-%d")
TARGET_URLS = [
    f"https://eksisozluk.com/basliklar/tarih/{TODAY_STR}",
    "https://eksisozluk.com/basliklar/gundem",
    "https://eksisozluk.com/basliklar/populer",
    "https://eksisozluk1923.com/basliklar/gundem",
]

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "tr,tr-TR;q=0.9,en-US;q=0.8,en;q=0.7"
}

def turkish_title(text: str) -> str:
    """Türkçe karakterleri (i -> İ, ı -> I) bozmadan kelime başlarını büyütür."""
    upper_map = {"i": "İ", "ı": "I"}
    words = text.split()
    formatted_words = []
    for word in words:
        if not word:
            continue
        first_char = word[0]
        rest = word[1:]
        first_upper = upper_map.get(first_char, first_char.upper())
        formatted_words.append(first_upper + rest)
    return " ".join(formatted_words)

def get_data_from_target_site():
    topic_list_repo = []
    
    for url in TARGET_URLS:
        try:
            print(f"🔗 Taranıyor: {url}")
            response = scraper.get(url, headers=headers, timeout=10)
            if response.status_code == 200:
                soup = BeautifulSoup(response.text, "html.parser")
                topic_list = soup.find("ul", class_=lambda x: x and "topic-list" in x)

                if topic_list:
                    items = topic_list.find_all("li")
                else:
                    items = soup.select("#partials li a, ul.topic-list li a")

                if items:
                    for li in items:
                        a_tag = li if li.name == "a" else li.find("a")
                        if a_tag:
                            small_tag = a_tag.find("small")
                            if small_tag:
                                small_tag.decompose()
                            
                            topic = a_tag.get_text(strip=True)
                            if topic and topic not in topic_list_repo:
                                topic_list_repo.append(topic)
                    
                    if topic_list_repo:
                        print(f"✅ Toplam {len(topic_list_repo)} başlık çekildi.")
                        return topic_list_repo
        except Exception as e:
            print(f"✕ Bağlantı hatası ({url}): {e}")

    return topic_list_repo

def get_already_saved_topics():
    """Daha önce kaydedilmiş tüm başlıkları küme olarak döner."""
    try:
        response = supabase.table("weekly_topics").select("topic").execute()
        return {row["topic"].strip().lower() for row in response.data if row.get("topic")}
    except Exception as e:
        print(f"Cache kontrol hatası: {e}")
        return set()

def get_unique_topic_from_groq(topic, retries=2):
    """Başlığı sözlük üslubuna çevirir ve Türkçe karakter kontrolü yapar."""
    system_prompt = (
        "Sen popüler Türk internet forumlarının kıdemli bir yazarısın. "
        "Görevin verilen gündem başlığını, anlamını, kişi ve olayları bozmadan doğal ve akıcı bir Türkçe sözlük başlığına çevirmektir.\n"
        "KURALLAR:\n"
        "1. Asla açıklama yapma. SADECE başlık metnini döndür.\n"
        "2. Türkçe karakterleri (ı, i, ğ, ü, ş, ö, ç) eksiksiz ve doğru kullan.\n"
        "3. Resmi veya haber dili kullanma; gündelik sözlük jargonu olsun."
    )

    for attempt in range(retries):
        try:
            gen_response = client.chat.completions.create(
                model="llama-3.1-70b-versatile",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": f"Şu başlığı sözlük formatında yeniden yaz: '{topic}'"}
                ],
                temperature=0.7
            )
            raw_title = gen_response.choices[0].message.content.strip().replace('"', '')

            verify_prompt = (
                f"Orijinal Başlık: '{topic}'\n"
                f"Üretilen Başlık: '{raw_title}'\n\n"
                "Bu üretilen başlık Türkçe dilbilgisi ve Türkçe karakterler açısından doğruysa sadece temiz halini yaz. "
                "Değilse orijinal başlığı en temiz haliyle döndür. Başka hiçbir açıklama yazma."
            )
            
            verify_response = client.chat.completions.create(
                model="llama-3.1-70b-versatile",
                messages=[
                    {"role": "system", "content": "Sen bir Türkçe redaktörüsün. Sadece temiz başlığı verirsin."},
                    {"role": "user", "content": verify_prompt}
                ],
                temperature=0.2
            )
            
            final_title = verify_response.choices[0].message.content.strip().replace('"', '')
            if final_title:
                return turkish_title(final_title)

        except Exception as e:
            print(f"Groq API Hatası (Deneme {attempt + 1}): {e}")
            time.sleep(1)

    return turkish_title(topic)

def save_to_supabase(original_topic, unique_topic):
    try:
        supabase.table("topics").insert({"topic_name": unique_topic}).execute()
        supabase.table("weekly_topics").insert({"topic": original_topic}).execute()
        print(f"✅ Yeni başlık veritabanına eklendi: '{original_topic}' -> #{unique_topic}")
        return True
    except Exception as e:
        print(f"✕ Supabase kayıt hatası: {e}")
        return False

def trigger_bot_runner():
    """Yeni eklenen başlık için TypeScript bot runner'ı tetikler."""
    print("\n🤖 Yorum botları tetikleniyor (runner.ts)...")
    npm_path = shutil.which("npm") or shutil.which("npm.cmd") or "npm"
    try:
        subprocess.run([npm_path, "run", "bot:run"], shell=True, check=True)
    except Exception as e:
        print(f"Bot runner çalıştırma hatası: {e}")

if __name__ == "__main__":
    print(f"🔍 Güncel sözlük başlıkları taranıyor...")
    raw_topics = get_data_from_target_site()
    
    if not raw_topics:
        print("İncelenecek başlık bulunamadı.")
        exit()

    saved_cache = get_already_saved_topics()
    found_new_topic = False

    # Cache'de olmayan İLK taze başlığı bul, ekle, botları çalıştır ve döngüyü tamamla
    for topic in raw_topics:
        if topic.strip().lower() in saved_cache:
            continue
        
        print(f"\n📌 Yeni taze başlık yakalandı: {topic}")
        unique_topic = get_unique_topic_from_groq(topic)
        
        if unique_topic:
            success = save_to_supabase(topic, unique_topic)
            if success:
                found_new_topic = True
                trigger_bot_runner()
                break  # Her periyotta sadece 1 yeni başlık ekler ve yorum botlarını sıraya sokar

    if not found_new_topic:
        print("\nℹ️ Tüm güncel başlıklar zaten cache'de mevcut. Yeni başlık bekleniyor.")

    print("\n🏁 Periyodik tur tamamlandı.")
