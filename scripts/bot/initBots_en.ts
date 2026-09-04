import { supabaseAdmin } from './config';
import { BOT_PERSONAS } from './personas';
import { BOT_PERSONAS_EN } from './personas_en'; // İngilizce persona havuzu

async function initBots() {
  // Hem TR hem EN persona listesini birleştiriyoruz
  const ALL_BOTS = [...BOT_PERSONAS, ...BOT_PERSONAS_EN];

  console.log(`🤖 Toplam ${ALL_BOTS.length} bot (TR + EN) senkronize ediliyor...`);

  // Auth kullanıcılarını tek seferde çek
  const { data: userListData } = await supabaseAdmin.auth.admin.listUsers();
  const allUsers = userListData?.users || [];

  for (const bot of ALL_BOTS) {
    let userId: string | null = null;

    // 1. Auth kontrolü
    const existingAuth = allUsers.find((u) => u.email === bot.email);

    if (existingAuth) {
      userId = existingAuth.id;
    } else {
      const { data: newUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: bot.email,
        password: 'BotPasswordSecure123!',
        email_confirm: true,
        user_metadata: { username: bot.username },
      });

      if (authError || !newUser.user) {
        console.error(`✕ @${bot.username} auth oluşturulamadı:`, authError?.message);
        continue;
      }
      userId = newUser.user.id;
      console.log(`✅ Yeni auth hesabı açıldı: @${bot.username}`);
    }

    if (!userId) continue;

    // 2. Profiles kontrolü & upsert
    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    let profileError;
    if (existingProfile) {
      const { error } = await supabaseAdmin
        .from('profiles')
        .update({
          username: bot.username,
          bio: bot.bio,
          avatar_url: bot.avatar_url,
        })
        .eq('id', userId);
      profileError = error;
    } else {
      const { error } = await supabaseAdmin.from('profiles').insert({
        id: userId,
        username: bot.username,
        bio: bot.bio,
        avatar_url: bot.avatar_url,
      });
      profileError = error;
    }

    if (profileError) {
      console.error(`✕ @${bot.username} profiles tablosuna eklenemedi:`, profileError.message);
    } else {
      console.log(`🎉 @${bot.username} profili hazır.`);
    }
  }

  console.log('✨ Tüm bot hesapları başarıyla senkronize edildi.');
}

initBots();
