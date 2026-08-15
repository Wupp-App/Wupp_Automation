import cloudscraper
from bs4 import BeautifulSoup
import os
import re
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
target_url = "https://eksisozluk.com/"

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "tr,tr-TR;q=0.9,en-US;q=0.8,en;q=0.7"
}

# Bozuk çıktı tespiti için: aynı karakterin art arda 4+ kez tekrarı,
# beklenmedik semboller, veya boş/çok kısa çıktı gibi durumları yakalar.
GARBLED_PATTERN = re.compile(r'(.)\1{3,}')
ALLOWED_CHARS_PATTERN = re.compile(r'^[a-zA-ZçÇğĞıİöÖşŞüÜ0-9\s.,!?\'":;()\-%/&+]+$')


def is_output_valid(original_topic, candidate):
    """Üretilen başlığın bozuk/saçma olup olmadığını kontrol eder."""
    if not candidate or not candidate.strip():
        return False

    candidate = candidate.strip()

    # Çok kısa veya aşırı uzun çıktılar şüpheli (orijinale oranla)
    if len(candidate) < 3:
        return False
    if len(candidate) > len(original_topic) * 4 + 20:
        return False

    # Art arda tekrarlayan karakter (karakter karışması belirtisi)
    if GARBLED_PATTERN.search(candidate):
        return False

    # İzin verilmeyen garip semboller/karakterler içeriyorsa
    if not ALLOWED_CHARS_PATTERN.match(candidate):
        return False

    # En az bir harf içermeli (sadece sayı/sembol olmasın)
    if not re.search(r'[a-zA-ZçÇğĞıİöÖşŞüÜ]', candidate):
        return False

    return True


def get_unique_topic_from_groq(topic, attempts=5, retries_per_attempt=3, delay=2):
    """
    Groq'tan başlığı yeniden yazmasını ister. Karakter karışması / saçmalama
    riskine karşı en fazla `attempts` kere yeni bir aday üretir, her adayı
    is_output_valid ile doğrular ve ilk geçerli sonucu döner.
    Hiçbir aday geçerli değilse orijinal başlığı döner.
    """
    prompt = (
        "You are a long-time user of a popular Turkish internet forum (like Ekşi Sözlük or İncisözlük). "
        "Your task is to rewrite the given input title into a natural, casual, and informal Turkish forum/sözlük thread title.\n\n"
        "STRICT LAWS:\n"
        "1. Absolutely DO NOT make explanations. Output ONLY the rewritten title.\n"
        "2. Do not use a formal, academic, or news-headline tone. Write exactly how a Turkish user speaks on a forum (totally lowercase is completely fine).\n"
        "3. Keep the exact core meaning, names, dates, and entities of the input title, but shake up the wording to make it sound like a natural forum entry title.\n"
        "4. MANDATORY: The final output must be in TURKISH.\n"
        "5. CRITICAL REVIEW: Before outputting, double-check your generated title to ensure it maintains perfect semantic integrity and makes complete logical sense.\n"
        "6. Pay Close Attention To The Context, Environment, And Specific Names Mentioned In The Title. Maintain Perfect Semantic Integrity And Turn It Into A Forum Thread Title Without Losing Its Core Meaning.\n"
        "7. Capitalize The First Letter Of Every Single Word In The Output Title.\n"
        "8. Never repeat the same character more than 2 times in a row. Never output broken, garbled, or corrupted characters.\n\n"
        f"Input Title To Rewrite: {topic}"
    )

    for attempt_num in range(1, attempts + 1):
        candidate = None

        # Her adayı üretmek için kısa retry mantığı (ağ/API hatalarına karşı)
        for attempt in range(retries_per_attempt):
            try:
                time.sleep(0.5)
                response = client.chat.completions.create(
                    model="llama-3.3-70b-versatile",
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.9
                )
                if response and response.choices[0].message.content:
                    candidate = response.choices[0].message.content.strip().replace('"', '')
                break
            except Exception as e:
                if attempt < retries_per_attempt - 1:
                    time.sleep(delay)
                    delay *= 2
                else:
                    print(f"LLM Hatası (deneme {attempt_num}): {e}")

        if candidate and is_output_valid(topic, candidate):
            if attempt_num > 1:
                print(f"'{topic}' için {attempt_num}. denemede geçerli sonuç bulundu: {candidate}")
            return candidate

        print(f"Geçersiz/bozuk çıktı, tekrar deneniyor ({attempt_num}/{attempts}): {candidate!r}")

    print(f"'{topic}' için {attempts} denemede geçerli sonuç üretilemedi, orijinal başlık kullanılacak.")
    return topic


def get_data_from_target_site():
    topic_list_repo = []
    try:
        response = scraper.get(target_url, headers=headers)
        
        if response.status_code == 200:
            soup = BeautifulSoup(response.text, "html.parser")
            topic_list = soup.find("ul", class_=lambda x: x and "topic-list" in x)

            if topic_list:
                items = topic_list.find_all("li")[:20]
            else:
                items = soup.select("#partials li a, ul.topic-list li a")[:20]

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
                print("Topics Not Found.")
        else:
            print(f"Error Code: {response.status_code}")

    except Exception as e:
        print(f"Connection Error: {e}")
    return topic_list_repo


def check_if_topic_processed_today(topic):
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    try:
        response = supabase.table("weekly_topics")\
                    .select("topic")\
                    .eq("topic", topic)\
                    .gte("created_at", f"{today}T00:00:00.000Z") \
                    .lte("created_at", f"{today}T23:59:59.999Z") \
                    .execute()
        return len(response.data) > 0
    except Exception as e:
        print(f"Supabase kontrol hatası: {e}")
        return True


def save_to_supabase(original_topic, unique_topic):
    try:
        supabase.table("topics").insert({"topic_name": unique_topic}).execute()
        supabase.table("weekly_topics").insert({"topic": original_topic}).execute()
        print(f"Başarıyla işlendi: {original_topic} -> {unique_topic}")
    except Exception as e:
        print(f"Kayıt esnasında Supabase hatası: {e}")


if __name__ == "__main__":
    print("Sözlük botu başlatıldı...")
    raw_topics = get_data_from_target_site()
    
    if raw_topics:
        for topic in raw_topics:
            if check_if_topic_processed_today(topic):
                print(f"Bu başlık bugün zaten işlenmiş, atlanıyor: {topic}")
                continue
            
            print(f"Yeni başlık bulundu, yapay zekaya gönderiliyor: {topic}")
            unique_topic = get_unique_topic_from_groq(topic)
            
            if unique_topic and not unique_topic.startswith("[Error"):
                save_to_supabase(topic, unique_topic)
            
            time.sleep(1)
