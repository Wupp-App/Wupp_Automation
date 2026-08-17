import cloudscraper
from bs4 import BeautifulSoup
import os
import subprocess
from groq import Groq 
import time
from supabase import create_client, Client
from datetime import datetime, timezone

supabase_url = os.environ.get("SUPABASE_URL")
supabase_key = os.environ.get("SUPABASE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

supabase: Client = create_client(supabase_url, supabase_key)
client = Groq(api_key=GROQ_API_KEY)

scraper = cloudscraper.create_scraper()
# Anlık taze başlıklar için doğrudan 'bugün' akışına bakar
target_url = "https://eksisozluk.com/basliklar/bugun"

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "tr,tr-TR;q=0.9,en-US;q=0.8,en;q=0.7"
}

def turkish_title(text: str) -> str:
    """Türkçe karakterleri (i -> İ, ı -> I) bozmadan kelime başlarını büyütür."""
    lower_map = {"I": "ı", "İ": "i"}
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
    try:
        response = scraper.get(target_url, headers=headers)
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
        else:
            print(f"Siteye erişilemedi. Hata Kodu: {response.status_code}")
    except Exception as e:
        print(f"Bağlantı hatası: {e}")
    return topic_list_repo

def is_topic_already_saved(topic):
    """Bu başlığın daha önce hiç işlenip işlenmediğini kontrol eder."""
    try:
        response = supabase.table("weekly_topics")\
                    .select("topic")\
                    .eq("topic", topic)\
                    .limit(1)\
                    .execute()
        return len(response.data) > 0
    except Exception as e:
        print(f"Supabase kontrol hatası: {e}")
        return True

def get_unique_topic_from_groq(topic, retries=3):
    """Başlığı sözlük üslubuna çevirir ve 2. aşamada Türkçe kontrolü yapar."""
    system_prompt = (
        "Sen Ekşi Sözlük gibi popüler Türk internet forumlarının kıdemli bir yazarısın. "
        "Görevin verilen gündem başlığını, anlamını, kişi ve olayları bozmadan doğal ve akıcı bir Türkçe sözlük başlığına çevirmektir.\n"
        "KURALLAR:\n"
        "1. Asla açıklama yapma. SADECE başlık metnini döndür.\n"
        "2. Türkçe karakterleri (ı, i, ğ, ü, ş, ö, ç) eksiksiz ve doğru kullan.\n"
        "3. Resmi veya haber dili kullanma; gündelik sözlük jargonu olsun.\n"
        "4. Anlamsız, saçma veya bağlamından kopuk kelime öbekleri üretme."
    )

    for attempt in range(retries):
        try:
            # 1. Aşama: Başlığı yeniden yaz
            gen_response = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": f"Şu başlığı sözlük formatında yeniden yaz: '{topic}'"}
                ],
                temperature=0.7
            )
            raw_title = gen_response.choices[0].message.content.strip().replace('"', '')

            # 2. Aşama: İki kez kontrol (Self-Correction & Türkçe İmla)
            verify_prompt = (
                f"Orijinal Başlık: '{topic}'\n"
                f"Üretilen Başlık: '{raw_title}'\n\n"
                "Bu üretilen başlık Türkçe dilbilgisi, anlam bütünlüğü ve Türkçe karakterler açısından mantıklı mı? "
                "Eğer mantıklıysa sadece düzeltilmiş halini yaz. Eğer saçmaysa veya anlamsızsa orijinal başlığı en temiz haliyle döndür. "
                "Sadece ve sadece başlığı döndür, başka hiçbir şey yazma."
            )
            
            verify_response = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[
                    {"role": "system", "content": "Sen bir Türkçe redaktörüsün. Sadece temizlenmiş başlığı verirsin."},
                    {"role": "user", "content": verify_prompt}
                ],
                temperature=0.2
            )
            
            final_title = verify_response.choices[0].message.content.strip().replace('"', '')
            if final_title:
                return turkish_title(final_title)

        except Exception as e:
            print(f"Groq API Deneme {attempt + 1} Hatası: {e}")
            time.sleep(2)

    return turkish_title(topic)

def save_to_supabase(original_topic, unique_topic):
    try:
        supabase.table("topics").insert({"topic_name": unique_topic}).execute()
        supabase.table("weekly_topics").insert({"topic": original_topic}).execute()
        print(f"✅ Yeni başlık başarıyla eklendi: '{original_topic}' -> #{unique_topic}")
        return True
    except Exception as e:
        print(f"✕ Supabase kayıt hatası: {e}")
        return False

def trigger_bot_runner():
    """Yeni başlık açılınca 30-50 botun yorum ve beğeni atmasını sağlar."""
    print("\n🤖 Yorum botları tetikleniyor (runner.ts)...")
    try:
        subprocess.run(["npm", "run", "bot:run"], check=True)
    except Exception as e:
        print(f"Bot runner çalıştırma hatası: {e}")

if __name__ == "__main__":
    print("🔍 Ekşi Sözlük taranıyor...")
    raw_topics = get_data_from_target_site()
    
    if not raw_topics:
        print("İncelenecek başlık bulunamadı.")
        exit()

    found_new_topic = False

    # Daha önce hiç işlenmemiş İLK başlığı bul, ekle ve botları tetikle
    for topic in raw_topics:
        if is_topic_already_saved(topic):
            continue
        
        print(f"\n📌 Yeni taze başlık yakalandı: {topic}")
        unique_topic = get_unique_topic_from_groq(topic)
        
        if unique_topic:
            success = save_to_supabase(topic, unique_topic)
            if success:
                found_new_topic = True
                trigger_bot_runner()
                break  # Sadece 1 yeni başlık ekleyip bu turu tamamla

    if not found_new_topic:
        print("ℹ️ Ekşi Sözlük'teki tüm güncel başlıklar zaten veritabanında mevcut. Yeni başlık bekleniyor.")

    print("\n🏁 Periyodik tur tamamlandı.")
