const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// Инициализация
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const SUPER_ADMIN = "6176762600";
const KEYS_PER_PAGE = 4;

// Временное хранилище состояний для ожидания ввода текста
const userSessions = {};

// Функция проверки: является ли пользователь админом
async function isAdmin(userId, username) {
    if (String(userId) === SUPER_ADMIN) return true;
    
    // Проверяем по ID
    let { data: adminId } = await supabase.from('bot_admins').select('*').eq('user_id', String(userId));
    if (adminId && adminId.length > 0) return true;

    // Проверяем по Username (если есть)
    if (username) {
        let { data: adminUser } = await supabase.from('bot_admins').select('*').eq('user_id', username.toLowerCase());
        if (adminUser && adminUser.length > 0) return true;
    }
    return false;
}

// Генератор ключей (формат: xxxx-HWID-TEST-xxxx из строчных букв и цифр)
function generateKey() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const genPart = (len) => Array.from({length: len}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${genPart(4)}-HWID-${genPart(4)}-${genPart(4)}`;
}

// Главное меню
const mainMenu = Markup.keyboard([
    ['создать ключ HWID', '📝 Создать апдейт'],
    ['активные ключи HWID', 'Настройки бота']
]).resize();

// Функция для жесткого сброса сессии при нажатии главных текстовых команд
function clearSession(userId) {
    if (userSessions[userId]) {
        delete userSessions[userId];
    }
}

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    clearSession(userId);
    
    if (!(await isAdmin(userId, ctx.from.username))) {
        return ctx.reply("❌ Доступ заблокирован. Вы не являетесь администратором.");
    }
    
    ctx.reply("👋 Добро пожаловать в панель управления NoobleScript!", mainMenu);
});

// Слушатель обычного текста
bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;

    // Защита от «вечных» сессий: если текст совпадает с главной кнопкой меню, сбрасываем состояние и идем дальше
    if (['создать ключ HWID', '📝 Создать апдейт', 'активные ключи HWID', 'Настройки бота'].includes(text)) {
        clearSession(userId);
        return next();
    }

    // 1. Логика добавления админа
    if (userSessions[userId] === 'await_admin_input') {
        delete userSessions[userId];
        let target = text.trim().replace('@', '');
        
        const { error } = await supabase.from('bot_admins').insert({
            user_id: target.toLowerCase(),
            added_by: String(userId)
        });

        if (error) {
            return ctx.reply("❌ Ошибка: Этот пользователь уже есть в списке админов или произошел сбой.");
        }
        return ctx.reply(`✅ Пользователь "${target}" успешно добавлен в базу администраторов!\nВсе, что ему нужно — зайти в бота и прописать /start`);
    }

    // 2. Логика обработки кастомного графика
    if (userSessions[userId] === 'await_custom_graph') {
        if (!text.includes('/')) {
            return ctx.reply("❌ Ошибка! Отсутствует разделитель `/`. Попробуйте еще раз в формате `ГГГГ.ММ.ДД / Название подписки` или нажмите любую кнопку меню для отмены.");
        }

        const parts = text.split('/');
        const datePart = parts[0].trim().replace(/\./g, '-'); 
        let tierName = parts[1].trim();

        const hasQuotes = /^([\"'])(.*)\1$/.test(tierName);
        if (!hasQuotes) {
            tierName = `"${tierName}"`;
        }

        const expiresAt = new Date(`${datePart}T23:59:59`);
        if (isNaN(expiresAt.getTime())) {
            return ctx.reply("❌ Неверный формат даты! Пример: `2026.05.20 / Окак` или нажмите кнопку меню для отмены.");
        }

        delete userSessions[userId]; 
        const newKey = generateKey();

        const { error } = await supabase.from('keys').insert({
            key: newKey,
            expires_at: expiresAt.toISOString(),
            status: 'active',
            tier: tierName 
        });

        if (error) {
            return ctx.reply(`❌ Не удалось сохранить ключ в базу данных: ${error.message}`);
        }

        return ctx.reply(`✅ **Кастомный ключ успешно создан!**\n\n` +
                         `🔑 Ключ: \`${newKey}\`\n` +
                         `💎 Название подписки: *${tierName}*\n` +
                         `⏳ Действует до: ${expiresAt.toLocaleString('ru-RU')}\n\n` +
                         `👉 Отправь его покупателю. Скрипт сам привяжет его HWID при входе.`, 
                         { parse_mode: 'Markdown' });
    }

    // 3. Логика создания апдейт лога
    if (userSessions[userId] === 'await_update_log') {
        if (!text.includes('|')) {
            return ctx.reply('❌ Ошибка! Используйте черту `|` для разделения версии и описания. Попробуйте еще раз или нажмите любую кнопку меню для отмены:');
        }
        
        const parts = text.split('|');
        const version = parts[0].trim();
        const updateText = parts.slice(1).join('|').trim();
        
        delete userSessions[userId];

        const { error } = await supabase.from('updates').insert([
            { version: version, text: updateText }
        ]);
        
        if (error) {
            return ctx.reply(`❌ Ошибка БД при создании апдейта: ${error.message}`);
        }
        return ctx.reply(`🚀 **Апдейт успешно добавлен в базу!**\n\n📦 Версия: *${version}*`);
    }

    return next();
});

// Нажатие: "📝 Создать апдейт"
bot.hears('📝 Создать апдейт', async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return;
    userSessions[ctx.from.id] = 'await_update_log';
    return ctx.reply('📝 Введите обновление в формате:\n`Версия | Текст описания`', { parse_mode: 'Markdown' });
});

// Нажатие: "создать ключ HWID"
bot.hears('создать ключ HWID', async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return;
    clearSession(ctx.from.id);
    
    const inlineMenu = Markup.inlineKeyboard([
        [Markup.button.callback('12 часов', 'gen_12h'), Markup.button.callback('24 часа', 'gen_24h')],
        [Markup.button.callback('3 дня', 'gen_3d'), Markup.button.callback('7 дней', 'gen_7d')],
        [Markup.button.callback('⚙️ Создать свой график', 'gen_custom_prompt')]
    ]);
    ctx.reply("⏱ Выберите срок действия лицензионного ключа:", inlineMenu);
});

// Обработка генерации стандартных ключей
const timeMaps = { '12h': 12*60, '24h': 24*60, '3d': 3*24*60, '7d': 7*24*60 };
bot.action(/^gen_(12h|24h|3d|7d)$/, async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    
    const durationType = ctx.match[1];
    const minutes = timeMaps[durationType];
    
    const newKey = generateKey();
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();

    const { error } = await supabase.from('keys').insert({
        key: newKey,
        expires_at: expiresAt,
        status: 'active',
        tier: durationType 
    });

    if (error) {
        return ctx.reply("❌ Не удалось сохранить ключ в базу данных.");
    }

    ctx.editMessageText(`✅ **Ключ успешно создан!**\n\n` +
                       `🔑 Ключ: \`${newKey}\`\n` +
                       `⏳ Действует до: ${new Date(expiresAt).toLocaleString('ru-RU')}\n\n` +
                       `👉 Отправь его покупателю. Скрипт сам привяжет его HWID при входе.`, 
                       { parse_mode: 'Markdown' });
});

// Обработка нажатия кнопки "Создать свой график"
bot.action('gen_custom_prompt', async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    
    userSessions[ctx.from.id] = 'await_custom_graph';
    ctx.answerCbQuery();
    
    return ctx.editMessageText('⚙️ **Режим создания своего графика**\n\n' +
                               'Пришлите сообщение строго в формате:\n' +
                               '`ГГГГ.ММ.ДД / Название подписки` \n\n' +
                               '*Пример:* `2026.05.20 / Окак` \n\n' +
                               '_(Если вы будете нажимать кнопки меню, режим автоматически сбросится)_', 
                               { parse_mode: 'Markdown' });
});

// Нажатие: "Настройки бота"
bot.hears('Настройки бота', async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return;
    clearSession(ctx.from.id);
    
    ctx.reply("⚙️ Настройки бота:", Markup.inlineKeyboard([
        [Markup.button.callback("👥 Список админов", "view_admins_list")],
        [Markup.button.callback("➕ Добавить админа", "add_admin_prompt")]
    ]));
});

// Просмотр списка админов из базы данных
bot.action("view_admins_list", async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    ctx.answerCbQuery();

    const { data: admins, error } = await supabase.from('bot_admins').select('*');
    if (error) return ctx.reply("❌ Не удалось загрузить список администраторов.");

    let text = `👥 **Список администраторов бота:**\n\n• \`${SUPER_ADMIN}\` (Создатель)\n`;
    admins.forEach((admin) => {
        text += `• \`${admin.user_id}\` (Добавил: ${admin.added_by || 'Админ'})\n`;
    });

    ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "back_to_settings")]]) });
});

bot.action("back_to_settings", async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    ctx.answerCbQuery();
    ctx.editMessageText("⚙️ Настройки бота:", Markup.inlineKeyboard([
        [Markup.button.callback("👥 Список админов", "view_admins_list")],
        [Markup.button.callback("➕ Добавить админа", "add_admin_prompt")]
    ]));
});

bot.action("add_admin_prompt", async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    userSessions[ctx.from.id] = 'await_admin_input';
    ctx.reply("✉️ Отправьте мне **ID** пользователя или его **Username** (можно без @), которого хотите сделать администратором:");
    ctx.answerCbQuery();
});

// Нажатие: "активные ключи HWID"
bot.hears('активные ключи HWID', async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return;
    clearSession(ctx.from.id);
    sendKeysPage(ctx, 0, false);
});

// Функция вывода списка ключей
async function sendKeysPage(ctx, page, isEdit = true) {
    const { data: allKeys, error } = await supabase.from('keys').select('*').order('id', { ascending: false });
    
    if (error || !allKeys || allKeys.length === 0) {
        const text = "📭 Активных ключей в базе данных не обнаружено.";
        return isEdit ? ctx.editMessageText(text) : ctx.reply(text);
    }

    const totalPages = Math.ceil(allKeys.length / KEYS_PER_PAGE);
    if (page >= totalPages) page = totalPages - 1;
    if (page < 0) page = 0;

    const startIdx = page * KEYS_PER_PAGE;
    const pageKeys = allKeys.slice(startIdx, startIdx + KEYS_PER_PAGE);

    let msgText = `📋 **Список активных ключей (Страница ${page + 1}/${totalPages}):**\n\n`;
    const inlineButtons = [];

    pageKeys.forEach((k, index) => {
        const displayIdx = startIdx + index + 1;
        const hwidStatus = k.hwid ? "🔒 Привязан" : "🔓 Свободен";
        const tierInfo = k.tier ? ` [${k.tier}]` : "";
        
        let statusIcon = "🟢";
        if (k.status === 'blocked') statusIcon = "🚫";
        
        msgText += `${statusIcon} ${displayIdx}. \`${k.key}\`${tierInfo} [${hwidStatus}]\n`;
        inlineButtons.push([Markup.button.callback(`🔍 Посмотреть номер [${displayIdx}]`, `view_key_${k.id}_${page}`)]);
    });

    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback("⬅️ Назад", `page_${page - 1}`));
    if (page < totalPages - 1) navRow.push(Markup.button.callback("Вперед ➡️", `page_${page + 1}`));
    
    if (navRow.length > 0) {
        inlineButtons.push(navRow);
    }

    if (isEdit) {
        ctx.editMessageText(msgText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(inlineButtons) });
    } else {
        ctx.reply(msgText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(inlineButtons) });
    }
}

// Переключение страниц
bot.action(/^page_(.+)$/, async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    const targetPage = parseInt(ctx.match[1]);
    sendKeysPage(ctx, targetPage, true);
    ctx.answerCbQuery();
});

// Просмотр детальной информации о ключе
bot.action(/^view_key_(.+)_(.+)$/, async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    const keyId = ctx.match[1];
    const backPage = parseInt(ctx.match[2]);

    const { data } = await supabase.from('keys').select('*').eq('id', keyId);
    if (!data || data.length === 0) {
        return ctx.answerCbQuery("Ключ не найден.", { show_alert: true });
    }

    const k = data[0];
    const hwidInfo = k.hwid ? `\`${k.hwid}\`` : "Не активирован (ожидает первого входа)";
    const tierDetails = k.tier ? `\n• **Тариф:** ${k.tier}` : "";
    
    const details = `🔑 **Информация о ключе:**\n\n` +
                    `• **Ключ:** \`${k.key}\`${tierDetails}\n` +
                    `• **HWID:** ${hwidInfo}\n` +
                    `• **Статус:** \`${k.status}\`\n` +
                    `• **Истекает:** ${new Date(k.expires_at).toLocaleString('ru-RU')}\n` +
                    `• **Создан:** Администратором бота\n`;

    // Динамическая кнопка блокировки на основе статуса ключа в БД
    const blockButtonText = k.status === 'blocked' ? "🟢 Разблокировать" : "🚫 Заблокировать";
    const blockAction = `toggle_block_${k.id}_${backPage}`;

    const actions = Markup.inlineKeyboard([
        [Markup.button.callback(blockButtonText, blockAction), Markup.button.callback("🖥 Сбросить HWID", `reset_hwid_${k.id}_${backPage}`)],
        [Markup.button.callback("🗑 Удалить ключ", `delete_key_${k.id}_${backPage}`)],
        [Markup.button.callback("⬅️ К списку", `page_${backPage}`)]
    ]);

    ctx.editMessageText(details, { parse_mode: 'Markdown', ...actions });
    ctx.answerCbQuery();
});

// Смена статуса: заблокировать/разблокировать
bot.action(/^toggle_block_(.+)_(.+)$/, async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    const keyId = ctx.match[1];
    const backPage = parseInt(ctx.match[2]);

    const { data: keyData } = await supabase.from('keys').select('status').eq('id', keyId).single();
    if (!keyData) return ctx.answerCbQuery("Ключ не найден.");

    const newStatus = keyData.status === 'blocked' ? 'active' : 'blocked';
    await supabase.from('keys').update({ status: newStatus }).eq('id', keyId);

    ctx.answerCbQuery(`Статус изменен на: ${newStatus}`);
    
    // Перезапускаем просмотр этого же ключа, чтобы обновить инлайн-кнопку и текст
    return bot.handleAction(`view_key_${keyId}_${backPage}`, ctx);
});

// Сброс HWID для ключа
bot.action(/^reset_hwid_(.+)_(.+)$/, async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    const keyId = ctx.match[1];
    const backPage = parseInt(ctx.match[2]);

    const { error } = await supabase.from('keys').update({ hwid: null }).eq('id', keyId);
    if (error) return ctx.answerCbQuery("Не удалось сбросить HWID.");

    ctx.answerCbQuery("HWID успешно сброшен (null)!");
    return bot.handleAction(`view_key_${keyId}_${backPage}`, ctx);
});

// Удаление ключа
bot.action(/^delete_key_(.+)_(.+)$/, async (ctx) => {
    if (!(await isAdmin(ctx.from.id, ctx.from.username))) return ctx.answerCbQuery("Нет прав");
    const keyId = ctx.match[1];
    const backPage = parseInt(ctx.match[2]);

    const { error } = await supabase.from('keys').delete().eq('id', keyId);

    if (error) {
        return ctx.answerCbQuery("Не удалось удалить ключ.", { show_alert: true });
    }

    ctx.answerCbQuery("Ключ успешно удален!", { show_alert: false });
    sendKeysPage(ctx, backPage, true);
});

// Запуск
bot.launch().then(() => console.log("🚀 Бот запущен через систему GitHub Actions!"));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
        
