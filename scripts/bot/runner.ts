import { createClient } from '@supabase/supabase-js';
import { BOT_PERSONAS, BotPersona } from './personas';
import { generateEntry } from './generator';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase ortam değişkenleri eksik!');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBotFlow() {
  console.log('🚀 En son eklenen başlık aranıyor...');

  // 1. Veritabanına en son eklenen 1 başlığı çek
  const { data: topics, error: topicError } = await supabase
    .from('topics')
    .select('topic_id, id, topic_name')
    .order('created_at', { ascending: false })
    .limit(1);

  if (topicError || !topics || topics.length === 0) {
    console.error('❌ Başlık bulunamadı:', topicError);
    return;
  }

  const currentTopic = topics[0];
  const targetTopicId = currentTopic.topic_id || currentTopic.id;
  const targetTopicName = currentTopic.topic_name;

  console.log(`🎯 Hedef Başlık Mühürlendi: #${targetTopicName} (ID: ${targetTopicId})`);

  // 2. Bu başlık altındaki mevcut entry'leri bağlam (context) için topla
  const { data: existingEntriesData } = await supabase
    .from('entries')
    .select('entry')
    .eq('topic_id', targetTopicId)
    .order('created_at', { ascending: true })
    .limit(15);

  const contextEntries: string[] = existingEntriesData?.map((e) => e.entry) || [];

  // 3. 10 ile 40 arasında rastgele hedef bot sayısı belirle
  const targetBotCount = Math.floor(Math.random() * (40 - 10 + 1)) + 10;
  
  // Personaları karıştır ve hedef adette tekil bot seç
  const shuffledPersonas = [...BOT_PERSONAS].sort(() => 0.5 - Math.random());
  const selectedBots: BotPersona[] = shuffledPersonas.slice(0, Math.min(targetBotCount, shuffledBots.length));

  console.log(`📋 Bu başlığa toplam ${selectedBots.length} farklı bot sırayla entry girecek.`);
  console.log(`🔒 Bu başlığın ${selectedBots.length} yorumu tamamlanmadan sistem sonlanmayacaktır.\n`);

  // 4. Botları eşzamanlı DEĞİL, sırayla (sequential) çalıştır
  for (let i = 0; i < selectedBots.length; i++) {
    const bot = selectedBots[i];
    console.log(`✍️ [${i + 1}/${selectedBots.length}] @${bot.username} sıraya girdi...`);

    // Profil ID'sini bul
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', bot.username)
      .maybeSingle();

    if (!profile) {
      console.warn(`⚠️ @${bot.username} profili veritabanında bulunamadı, bu bot atlanıyor.`);
      continue;
    }

    // AI API'lerinden sırayla entry üret (Groq -> Gemini -> Ollama -> Fallback)
    const generatedText = await generateEntry(targetTopicName, bot, contextEntries);

    // Supabase'e entry'i bas
    const { data: newEntry, error: insertError } = await supabase
      .from('entries')
      .insert({
        topic_id: targetTopicId,
        user_id: profile.id,
        entry: generatedText,
        likes: Math.floor(Math.random() * 12) + 1,
      })
      .select()
      .single();

    if (insertError) {
      console.error(`✕ @${bot.username} entry yazılamadı:`, insertError.message);
    } else {
      console.log(`✅ [${i + 1}/${selectedBots.length}] @${bot.username}: "${generatedText}"`);
      // Sonraki botların bağlamı (sohbet akışı) için listeye ekle
      contextEntries.push(generatedText);
    }

    // 5. API Rate-Limit ve Kota Koruması: Her entry arası 12 - 20 saniye güvenli bekleme
    if (i < selectedBots.length - 1) {
      const waitTimeSec = Math.floor(Math.random() * (20 - 12 + 1)) + 12;
      console.log(`⏳ [Kota Koruması] Sonraki yazar için ${waitTimeSec} saniye bekleniyor...\n`);
      await sleep(waitTimeSec * 1000);
    }
  }

  console.log(`\n🎉 #${targetTopicName} başlığına ait ${selectedBots.length} bot yorumunun tamamı başarıyla girildi!`);
}

runBotFlow();
