import { supabase } from './config';
import { botPersonas } from './personas';
import { generateEntry } from './generator';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBotFlow() {
  console.log('🚀 En son açılan başlık aranıyor...');

  // 1. En güncel başlığı çek
  const { data: topics, error: topicError } = await supabase
    .from('topics')
    .select('topic_id, topic_name')
    .order('created_at', { ascending: false })
    .limit(1);

  if (topicError || !topics || topics.length === 0) {
    console.error('❌ Başlık bulunamadı veya veritabanı hatası:', topicError);
    return;
  }

  const currentTopic = topics[0];
  console.log(`🎯 Hedef Başlık: #${currentTopic.topic_name} (ID: ${currentTopic.topic_id})`);

  // 2. Mevcut entry'leri al
  const { data: existingEntriesData } = await supabase
    .from('entries')
    .select('entry')
    .eq('topic_id', currentTopic.topic_id)
    .order('created_at', { ascending: true })
    .limit(10);

  const existingEntries = existingEntriesData?.map((e) => e.entry) || [];

  // 3. Botları karıştır ve 10-15 botluk liste oluştur
  const shuffledBots = [...botPersonas].sort(() => 0.5 - Math.random());
  const selectedBots = shuffledBots.slice(0, Math.min(15, shuffledBots.length));

  console.log(`👉 #${currentTopic.topic_name} başlığı için ${selectedBots.length} bot sıraya alındı.\n`);

  for (let i = 0; i < selectedBots.length; i++) {
    const bot = selectedBots[i];
    console.log(`✍️ [${i + 1}/${selectedBots.length}] @${bot.username} yorum üretiyor...`);

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', bot.username)
      .single();

    if (!profile) {
      console.warn(`⚠️ @${bot.username} profili bulunamadı, atlanıyor.`);
      continue;
    }

    // AI üretimi (Fail-Safe ile asla boş dönmez)
    const generatedText = await generateEntry(currentTopic.topic_name, bot, existingEntries);

    // Entry'yi kaydet
    const { data: newEntry, error: insertError } = await supabase
      .from('entries')
      .insert({
        topic_id: currentTopic.topic_id,
        user_id: profile.id,
        entry: generatedText,
        likes: Math.floor(Math.random() * 15) + 1,
      })
      .select()
      .single();

    if (insertError) {
      console.error(`❌ @${bot.username} entry kaydedilemedi:`, insertError.message);
    } else {
      console.log(`✅ [Entry #${newEntry.id || ''}] @${bot.username}: "${generatedText}"`);
      existingEntries.push(generatedText);
    }

    // İki yorum arası 30 - 50 saniye güvenli bekleme
    if (i < selectedBots.length - 1) {
      const waitSeconds = Math.floor(Math.random() * (50 - 30 + 1)) + 30;
      console.log(`⏳ Sonraki yorum için ${waitSeconds} saniye bekleniyor (Kota ve kilitlenme koruması)...\n`);
      await sleep(waitSeconds * 1000);
    }
  }

  console.log('\n🏁 Tüm bot yorumları başarıyla tamamlandı!');
}

runBotFlow();
