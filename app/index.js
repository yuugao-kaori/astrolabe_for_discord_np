import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActivityType  } from 'discord.js';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { promises as fs } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// データベースディレクトリの作成と初期化
const dbDir = `${__dirname}/data`;
await fs.mkdir(dbDir, { recursive: true });
const db = new sqlite3.Database(`${dbDir}/messages.db`);

// データベーステーブルの初期化
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      guild_id TEXT,
      channel_id TEXT,
      author_id TEXT,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // メール通知設定用テーブルを追加
  db.run(`
    CREATE TABLE IF NOT EXISTS notification_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      guild_id TEXT,
      email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, guild_id, email)
    )
  `);

  // メール送信履歴用テーブルを追加
  db.run(`
    CREATE TABLE IF NOT EXISTS email_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id)
    )
  `);

  // デバッグモード設定用テーブルを追加
  db.run(`
    CREATE TABLE IF NOT EXISTS debug_settings (
      guild_id TEXT PRIMARY KEY,
      is_dev_mode BOOLEAN DEFAULT FALSE
    )
  `);

  // 除外チャンネル設定用テーブルを追加
  db.run(`
    CREATE TABLE IF NOT EXISTS excluded_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT,
      channel_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, channel_id)
    )
  `);
});

dotenv.config();

// メール送信の設定
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'seitendan@gmail.com',
    pass: process.env.GOOGLE_APP_PASSWORD
  }
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // 追加
  ]
});

// メール送信関数を削除
// sendStartupMail関数を新しいログ送信関数に置き換え
const sendStartupLog = async () => {
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_LOG_SERVERID);
    const channel = await guild.channels.fetch(process.env.DISCORD_LOG_CHANNELID);
    await channel.send('Discordボットが起動しました。');
    console.log('Startup notification sent to Discord channel');
  } catch (error) {
    console.error('Error sending startup notification to Discord:', error);
  }
};

// スラッシュコマンドの定義
const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with pong!'),
  new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register email for message notifications')
    .addStringOption(option =>
      option.setName('email')
        .setDescription('Email address to receive notifications')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Cancel email notifications for this server'),
  new SlashCommandBuilder()
    .setName('mode')
    .setDescription('Set server mode')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Server mode type')
        .setRequired(true)
        .addChoices(
          { name: 'production', value: 'prod' },
          { name: 'development', value: 'dev' }
        )),
  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Check your email notification registration status'),
  new SlashCommandBuilder()
    .setName('exclusion')
    .setDescription('Manage channel exclusion settings')
    .addStringOption(option =>
      option.setName('action')
        .setDescription('Action to perform')
        .setRequired(true)
        .addChoices(
          { name: 'add', value: 'add' },
          { name: 'remove', value: 'remove' },
          { name: 'list', value: 'list' }
        ))
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Target channel')
        .setRequired(false)), // listの場合は不要なのでfalse
  new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show all available commands and their descriptions'),
  new SlashCommandBuilder()
    .setName('readme')
    .setDescription('Show all available commands and their descriptions'),
  new SlashCommandBuilder()
    .setName('readme_adminoptions')
    .setDescription('Show administrator-only commands and their descriptions'),
];

// コマンドを登録
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

try {
  console.log('Started refreshing application (/) commands.');

  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands },
  );

  console.log('Successfully reloaded application (/) commands.');
} catch (error) {
  console.error(error);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  client.user.setActivity({ 
    name: '/help',
    type: ActivityType.Playing
});
  sendStartupLog();
});


// メール送信可能かチェックする関数
const canSendEmail = async (guildId) => {
  try {
    // デバッグモードをチェック
    const debugMode = await new Promise((resolve, reject) => {
      db.get(
        'SELECT is_dev_mode FROM debug_settings WHERE guild_id = ?',
        [guildId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row?.is_dev_mode || false);
        }
      );
    });

    if (debugMode) return true;  // デバッグモードの場合は制限を無視

    // 通常の制限チェック処理
    const result = await new Promise((resolve, reject) => {
      db.get(
        'SELECT sent_at FROM email_history WHERE guild_id = ?',
        [guildId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!result) return true;

    const lastSent = new Date(result.sent_at);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    return lastSent < oneHourAgo;
  } catch (error) {
    console.error('Error checking email history:', error);
    return false;
  }
};

// 送信履歴を更新する関数
const updateEmailHistory = async (guildId) => {
  try {
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT OR REPLACE INTO email_history (guild_id, sent_at) VALUES (?, CURRENT_TIMESTAMP)',
        [guildId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  } catch (error) {
    console.error('Error updating email history:', error);
  }
};

// 新着メッセージ通知用のメール送信関数
const sendNewMessageMail = async (message) => {
  try {
    // 送信制限をチェック
    if (!await canSendEmail(message.guild.id)) {
      console.log('Skipping email notification due to rate limit');
      return;
    }

    // 対象サーバーの通知設定のみを取得（WHERE guild_id = ?）
    const emails = await new Promise((resolve, reject) => {
      db.all(
        'SELECT DISTINCT email FROM notification_settings WHERE guild_id = ?',
        [message.guild.id],  // このメッセージが投稿されたサーバーのIDのみ
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows.map(row => row.email));
        }
      );
    });

    if (emails.length === 0) return;

    const emailContent = `
      新着メッセージ:
      サーバー: ${message.guild.name}
      チャンネル: ${message.channel.name}
      投稿者: ${message.author.tag}
      内容: ${message.content}
      URL: ${message.url}
    `;

    for (const email of emails) {
      await transporter.sendMail({
        from: 'seitendan@gmail.com',
        to: email,
        subject: 'Discord新着メッセージ通知',
        text: emailContent
      });
    }

    // 送信履歴を更新
    await updateEmailHistory(message.guild.id);
    console.log('New message notification emails sent successfully');
  } catch (error) {
    console.error('Error sending new message email:', error);
  }
};

// メッセージ作成イベントのリスナー
client.on('messageCreate', async message => {
  // ボット自身のメッセージは無視
  if (message.author.bot) return;

  // チャンネルが除外リストに含まれているか確認
  const isExcluded = await new Promise((resolve, reject) => {
    db.get(
      'SELECT 1 FROM excluded_channels WHERE guild_id = ? AND channel_id = ?',
      [message.guild.id, message.channel.id],
      (err, row) => {
        if (err) reject(err);
        else resolve(!!row);
      }
    );
  });

  if (isExcluded) return;
  
  // メッセージをデータベースに保存
  db.run(`
    INSERT INTO messages (id, guild_id, channel_id, author_id, content)
    VALUES (?, ?, ?, ?, ?)
  `, [
    message.id,
    message.guild.id,
    message.channel.name,
    message.author.id,
    message.content
  ]);

  // 新着メッセージの通知メールを送信
  await sendNewMessageMail(message);
});

// プロセス終了時にDBをクローズ
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error(err);
    }
    process.exit(0);
  });
});

// スラッシュコマンドのハンドリング
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'check') {
    try {
      const result = await new Promise((resolve, reject) => {
        db.get(
          'SELECT email FROM notification_settings WHERE user_id = ? AND guild_id = ?',
          [interaction.user.id, interaction.guild.id],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (result) {
        await interaction.reply({ 
          content: `このサーバーで ${result.email} 宛にメール通知が登録されています。`, 
          ephemeral: true 
        });
      } else {
        await interaction.reply({ 
          content: 'このサーバーではメール通知が登録されていません。', 
          ephemeral: true 
        });
      }
    } catch (error) {
      console.error('Error checking notification status:', error);
      await interaction.reply({ 
        content: '登録状態の確認に失敗しました。', 
        ephemeral: true 
      });
    }
  } else if (commandName === 'ping') {
    await interaction.reply('Pong!');
  } else if (commandName === 'register') {
    const email = interaction.options.getString('email');
    
    // メールアドレスの簡単な検証
    if (!email.includes('@')) {
      await interaction.reply({ content: '無効なメールアドレスです。', ephemeral: true });
      return;
    }

    try {
      await new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO notification_settings (user_id, guild_id, email) VALUES (?, ?, ?)',
          [interaction.user.id, interaction.guild.id, email],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
      await interaction.reply({ content: 'メール通知の設定が完了しました。', ephemeral: true });
    // メール確認用のメッセージを送信
    await transporter.sendMail({
      from: 'seitendan@gmail.com',
      to: email,
      subject: 'Discord通知設定完了',
      text: `
        Discordメッセージ通知の設定が完了しました。
        サーバー: ${interaction.guild.name}
        このメールアドレスに新着メッセージの通知が送信されます。
        通知を解除したい場合は、Discordで /cancel コマンドを実行してください。
        
        もし、身に覚えのないメールである場合、お手数ですが、このメールにその旨を返信してください。
      `
    });
    } catch (error) {
      console.error('Error registering email:', error);
      await interaction.reply({ 
        content: 'メール通知の設定に失敗しました。既に登録されている可能性があります。', 
        ephemeral: true 
      });
    }
  } else if (commandName === 'cancel') {
    try {
      await new Promise((resolve, reject) => {
        db.run(
          'DELETE FROM notification_settings WHERE user_id = ? AND guild_id = ?',
          [interaction.user.id, interaction.guild.id],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
      await interaction.reply({ content: 'メール通知の登録を解除しました。', ephemeral: true });
    } catch (error) {
      console.error('Error canceling notification:', error);
      await interaction.reply({ 
        content: 'メール通知の登録解除に失敗しました。', 
        ephemeral: true 
      });
    }
  } else if (commandName === 'mode') {
    // 管理者権限チェック
    if (!interaction.member.permissions.has('ADMINISTRATOR')) {
      await interaction.reply({ content: 'この操作には管理者権限が必要です。', ephemeral: true });
      return;
    }

    const mode = interaction.options.getString('type');
    const isDevMode = mode === 'dev';

    try {
      await new Promise((resolve, reject) => {
        db.run(
          'INSERT OR REPLACE INTO debug_settings (guild_id, is_dev_mode) VALUES (?, ?)',
          [interaction.guild.id, isDevMode],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
      await interaction.reply({ 
        content: `サーバーモードを${isDevMode ? '開発' : '本番'}モードに変更しました。`,
        ephemeral: true 
      });
    } catch (error) {
      console.error('Error setting server mode:', error);
      await interaction.reply({ 
        content: 'サーバーモードの設定に失敗しました。',
        ephemeral: true 
      });
    }
  } else if (commandName === 'exclusion') {
    if (!interaction.member.permissions.has('ADMINISTRATOR')) {
      await interaction.reply({ content: 'この操作には管理者権限が必要です。', ephemeral: true });
      return;
    }

    const action = interaction.options.getString('action');
    const channel = interaction.options.getChannel('channel');

    if ((action === 'add' || action === 'remove') && !channel) {
      await interaction.reply({ 
        content: 'チャンネルを指定してください。', 
        ephemeral: true 
      });
      return;
    }

    if (action === 'add') {
      try {
        await new Promise((resolve, reject) => {
          db.run(
            'INSERT OR IGNORE INTO excluded_channels (guild_id, channel_id) VALUES (?, ?)',
            [interaction.guild.id, channel.id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
        await interaction.reply({ 
          content: `${channel.name} をメッセージ通知の除外リストに追加しました。`,
          ephemeral: true 
        });
      } catch (error) {
        console.error('Error adding channel to exclusion list:', error);
        await interaction.reply({ 
          content: 'チャンネルの除外設定に失敗しました。',
          ephemeral: true 
        });
      }
    } else if (action === 'remove') {
      try {
        // 先にチャンネルが除外リストに存在するか確認
        const existingChannel = await new Promise((resolve, reject) => {
          db.get(
            'SELECT channel_id FROM excluded_channels WHERE guild_id = ? AND channel_id = ?',
            [interaction.guild.id, channel.id],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });

        if (!existingChannel) {
          await interaction.reply({ 
            content: `${channel.name} は除外リストに登録されていません。`,
            ephemeral: true 
          });
          return;
        }

        await new Promise((resolve, reject) => {
          db.run(
            'DELETE FROM excluded_channels WHERE guild_id = ? AND channel_id = ?',
            [interaction.guild.id, channel.id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
        await interaction.reply({ 
          content: `${channel.name} を除外リストから削除しました。`,
          ephemeral: true 
        });
      } catch (error) {
        console.error('Error removing channel from exclusion list:', error);
        await interaction.reply({ 
          content: '除外設定の解除に失敗しました。',
          ephemeral: true 
        });
      }
    } else if (action === 'list') {
      try {
        const excludedChannels = await new Promise((resolve, reject) => {
          db.all(
            'SELECT channel_id FROM excluded_channels WHERE guild_id = ?',
            [interaction.guild.id],
            (err, rows) => {
              if (err) reject(err);
              else resolve(rows);
            }
          );
        });

        if (excludedChannels.length === 0) {
          await interaction.reply({
            content: '除外されているチャンネルはありません。',
            ephemeral: true
          });
          return;
        }

        const channelList = excludedChannels
          .map(row => `<#${row.channel_id}>`)
          .join('\n');

        await interaction.reply({
          content: `除外されているチャンネル:\n${channelList}`,
          ephemeral: true
        });
      } catch (error) {
        console.error('Error listing excluded channels:', error);
        await interaction.reply({ 
          content: '除外チャンネルの一覧取得に失敗しました。',
          ephemeral: true 
        });
      }
    }  } else if (commandName === 'help') {
      const commandHelps = [
        '**利用可能なコマンド一覧:**',
        '- `/ping` - ボットの応答確認',
        '- `/register [email]` - メール通知を登録 (emailは必須)',
        '- `/cancel` - メール通知の登録を解除',
        '- `/check` - メール通知の登録状態を確認',
        '- `/help` - このヘルプメッセージを表示'
      ].join('\n');
      await interaction.reply({ content: commandHelps, ephemeral: true });
  } else if (commandName === 'readme') {
    // 管理者権限チェック
    if (!interaction.member.permissions.has('ADMINISTRATOR')) {
      await interaction.reply({ content: 'この操作には管理者権限が必要です。', ephemeral: true });
      return;
    }
    const commandHelp = [
      '## このBotは、Discord内の投稿を検出するとメール通知を行います',
      '最大でも1時間に1度だけ通知されるので、メールが埋まる心配はありません。',
      'また、チャンネルを除外することもできるので、重要度の低いチャンネルは通知されません。',
      '※ただし、この機能は負荷の都合で、サーバ単位での設定になるため、管理者が行います',
      '**利用可能なコマンド一覧:**',
      '- `/ping` - ボットの応答確認',
      '- `/register [email]` - メール通知を登録 (emailは必須)',
      '- `/cancel` - メール通知の登録を解除',
      '- `/check` - メール通知の登録状態を確認',
      '- `/help` - ヘルプメッセージを表示'
    ].join('\n');
    await interaction.channel.send(commandHelp);
    await interaction.reply({ content: "詳細を投稿しました。", ephemeral: true });
  } else if (commandName === 'readme_adminoptions') {
    // 管理者権限チェック
    if (!interaction.member.permissions.has('ADMINISTRATOR')) {
      await interaction.reply({ content: 'この操作には管理者権限が必要です。', ephemeral: true });
      return;
    }
    const adminCommandHelp = [
      '**管理者が利用可能なコマンド一覧:**',
      '- `/mode [type]` - サーバーモードを設定 (管理者のみ)',
      '  - `production`: 本番モード',
      '  - `development`: 開発モード',
      '- `/exclusion [action] [channel]` - チャンネルの除外設定を管理 (管理者のみ)',
      '  - `add`: チャンネルを除外リストに追加',
      '  - `remove`: チャンネルを除外リストから削除',
      '  - `list`: 除外されているチャンネルを表示',
    ].join('\n');
    await interaction.reply({
      content: adminCommandHelp,
      ephemeral: true
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
