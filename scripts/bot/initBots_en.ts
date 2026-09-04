import { supabaseAdmin } from './config';
import { BOT_PERSONAS_EN } from './personas_en';

async function initBotsEn() {
  console.log(`🤖 Toplam ${BOT_PERSONAS_EN.length} İngilizce bot hesabı ve profil fotoğrafları senkronize ediliyor...`);

  const { data: userListData } = await supabaseAdmin.auth.admin.listUsers();
  const allUsers = userListData?.users || [];

  for (const bot of BOT_PERSONAS_EN) {
    let userId: string | null = null;

    const existingAuth = allUsers.find((u) => u.email === bot.email);

    if (existingAuth) {
      userId = existingAuth.id;
      console.log(`ℹ️ Auth hesabı mevcut: @${bot.username}`);
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
      console.log(`🎉 @${bot.username} profili ve fotoğrafı başarıyla güncellendi.`);
    }
  }

  console.log('✨ Tüm İngilizce bot hesapları ve fotoğrafları senkronize edildi.');
}

initBotsEn();
