import { supabaseAdmin } from './config';
import { BOT_PERSONAS } from './personas';

async function initBots() {
  console.log(`🤖 Toplam ${BOT_PERSONAS.length} bot hesabı senkronize ediliyor...`);

  for (const bot of BOT_PERSONAS) {
    let userId: string | null = null;

    // 1. Auth tarafında bu email var mı kontrol et
    const { data: userList } = await supabaseAdmin.auth.admin.listUsers();
    const existingAuth = userList?.users.find((u) => u.email === bot.email);

    if (existingAuth) {
      userId = existingAuth.id;
      console.log(`ℹ️ Auth hesabı zaten var: @${bot.username} (${bot.email})`);
    } else {
      // Yoksa Auth kullanıcısını oluştur
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
      console.log(`✅ Auth hesabı açıldı: @${bot.username}`);
    }

    if (!userId) continue;

    // 2. Profiles tablosuna zorla ekle/güncelle (Upsert)
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .upsert(
        {
          id: userId,
          username: bot.username,
          bio: bot.bio,
        },
        { onConflict: 'id' }
      );

    if (profileError) {
      console.error(`✕ @${bot.username} profiles tablosuna eklenemedi:`, profileError.message);
    } else {
      console.log(`🎉 @${bot.username} profili başarıyla güncellendi/eklendi.`);
    }
  }

  console.log('✨ Bot senkronizasyonu tamamlandı.');
}

initBots();
