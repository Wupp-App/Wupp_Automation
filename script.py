import os
import re
import sys
import time
import shutil
import subprocess
import json
import urllib.request
import cloudscraper
from bs4 import BeautifulSoup
from groq import Groq
from supabase import create_client, Client
from datetime import datetime, timezone

# Ortam Değişkenleri
SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:3b")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("❌ HATA: Supabase URL veya KEY bulunamadı!")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

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
                            
                            raw_text = a_tag.get_text(strip=True)
                            clean_topic = re.sub(r'\s+\d+$', '', raw_text).strip()
                            if clean_topic and clean_topic not in topic_list_repo:
                                topic_list_repo.append(clean_topic)
                    
                    if topic_list_repo:
                        print(f"✅ Toplam {len(topic_list_repo)} başlık çekildi.")
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

def query_groq(system_prompt: str, user_prompt: str, temperature=0.7) -> str | None:
    if not groq_client:
        return None
    models = ["llama3-70b-8192", "llama3-8b-8192", "mixtral-8x7b-32768"]
    for model in models:
        try:
            chat = groq_client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=temperature
            )
            text = chat.choices[0].message.content.strip().strip('"\'')
            if text:
                return text
        except Exception:
            pass
    return None

def query_ollama(system_prompt: str, user_prompt: str) -> str | None:
    try:
        req_data = json.dumps({
            "model": OLLAMA_MODEL,
            "stream": False,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "options": {"temperature": 0.7}
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{OLLAMA_HOST}/api/chat",
            data=req_data,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=15) as res:
            res_json = json.loads(res.read().decode())
            text = res_json.get("message", {}).get("content", "").strip()
            if text:
                return text.strip('"\'')
    except Exception:
        pass
    return None

def get_unique_topic_from_ai(topic: str) -> str:
    system_prompt = (
        "Sen popüler Türk internet forumlarının kıdemli bir yazarısın. "
        "Görevin verilen gündem başlığını, anlamını, kişi ve olayları bozmadan doğal ve akıcı bir Türkçe sözlük başlığına çevirmektir.\n"
        "KURALLAR:\n"
        "1. Asla açıklama yapma. SADECE başlık metnini döndür.\n"
        "2. Türkçe karakterleri (ı, i, ğ, ü, ş, ö, ç) eksiksiz ve doğru kullan.\n"
        "3. Resmi veya haber dili kullanma; gündelik sözlük jargonu olsun."
    )
    user_prompt = f"Şu başlığı sözlük formatında yeniden yaz: '{topic}'"

    raw_title = query_groq(system_prompt, user_prompt, temperature=0.7)
    if not raw_title:
        raw_title = query_ollama(system_prompt, user_prompt)

    if raw_title:
        return turkish_title(raw_title)
    return turkish_title(topic)

def save_to_supabase(original_topic: str, unique_topic: str) -> bool:
    try:
        supabase.table("topics").insert({"topic_name": unique_topic}).execute()
        supabase.table("weekly_topics").insert({"topic": original_topic}).execute()
        print(f"✅ Yeni başlık veritabanına eklendi: '{original_topic}' -> #{unique_topic}")
        return True
    except Exception as e:
        print(f"✕ Supabase kayıt hatası: {e}")
        return False

def trigger_bot_runner():
    print("\n🤖 Yorum botları tetikleniyor (runner.ts)...")
    npm_path = shutil.which("npm") or shutil.which("npm.cmd") or "npm"
    use_shell = os.name == "nt"
    try:
        subprocess.run([npm_path, "run", "bot:run"], shell=use_shell, check=True)
    except Exception as e:
        print(f"Bot runner çalıştırma hatası: {e}")

if __name__ == "__main__":
    print("🔍 Güncel sözlük başlıkları taranıyor...")
    raw_topics = get_data_from_target_site()
    
    if not raw_topics:
        print("İncelenecek başlık bulunamadı.")
        sys.exit(0)

    saved_cache = get_already_saved_topics()
    found_new_topic = False

    for topic in raw_topics:
        if topic.strip().lower() in saved_cache:
            continue
        
        print(f"\n📌 Yeni taze başlık yakalandı: {topic}")
        unique_topic = get_unique_topic_from_ai(topic)
        
        if unique_topic:
            success = save_to_supabase(topic, unique_topic)
            if success:
                found_new_topic = True
                trigger_bot_runner()
                break

    if not found_new_topic:
        print("\nℹ️ Tüm güncel başlıklar zaten cache'de mevcut. Yeni başlık bekleniyor.")

    print("\n🏁 Periyodik tur tamamlandı.")
