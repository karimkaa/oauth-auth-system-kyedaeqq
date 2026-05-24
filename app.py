import sys
sys.path.append(r"e:\projects_vc\project_registration\.venv\lib\site-packages")
from flask import Flask, request, jsonify, redirect, send_from_directory, make_response
from flask_cors import CORS
import sqlite3
import requests
import os
from werkzeug.utils import secure_filename
import random
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import string
import uuid
import base64
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont, ImageFilter

app = Flask(__name__)
CORS(app)

UPLOAD_FOLDER = 'uploads'
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

DB_FILE = 'users.db'

recovery_codes = {}
visited_ips = set()

# Yandex OAuth
YANDEX_CLIENT_ID     = '727fcfbc17eb48fd897fbeb085761404'
YANDEX_CLIENT_SECRET = '9b07f8b215284107b64bd0b872fdb5d3'

# Google OAuth
GOOGLE_CLIENT_ID     = "319592663812-ocrur4quh8j8vpikd10snhgvq87u7f2f.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET = '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'

# =========================================================

REDIRECT_URI_YANDEX = "http://127.0.0.1:5000/auth/yandex/callback"
REDIRECT_URI_GOOGLE = "http://127.0.0.1:5000/auth/google/callback"

def init_db():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT,
            google_id TEXT UNIQUE
        )
    ''')
    try:
        cursor.execute('ALTER TABLE users ADD COLUMN avatar TEXT')
    except sqlite3.OperationalError:
        pass
        
    try:
        cursor.execute('ALTER TABLE users ADD COLUMN bio TEXT')
    except sqlite3.OperationalError:
        pass
        
    try:
        cursor.execute('ALTER TABLE users ADD COLUMN phone TEXT')
    except sqlite3.OperationalError:
        pass
        
    try:
        cursor.execute('ALTER TABLE users ADD COLUMN birthdate TEXT')
    except sqlite3.OperationalError:
        pass

    try:
        cursor.execute('ALTER TABLE users ADD COLUMN username TEXT')
    except sqlite3.OperationalError:
        pass

    # Messages Table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_email TEXT NOT NULL,
            recipient_email TEXT NOT NULL,
            text TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    try:
        cursor.execute('ALTER TABLE messages ADD COLUMN timestamp DATETIME DEFAULT CURRENT_TIMESTAMP')
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute('ALTER TABLE messages ADD COLUMN parent_id INTEGER')
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute('ALTER TABLE messages ADD COLUMN attachment TEXT')
    except sqlite3.OperationalError:
        pass

    # Clean up and recreate server tables to seed new active conversations
    try:
        cursor.execute("SELECT count(*) FROM servers")
        count = cursor.fetchone()[0]
        if count <= 3:
            cursor.execute("DROP TABLE IF EXISTS servers")
            cursor.execute("DROP TABLE IF EXISTS server_channels")
            cursor.execute("DROP TABLE IF EXISTS server_messages")
    except sqlite3.OperationalError:
        pass

    # Servers, Channels and Server Messages Tables
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS servers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            owner_email TEXT NOT NULL,
            icon TEXT
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS server_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            FOREIGN KEY(server_id) REFERENCES servers(id)
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS server_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            sender_email TEXT NOT NULL,
            text TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(channel_id) REFERENCES server_channels(id)
        )
    ''')
    try:
        cursor.execute('ALTER TABLE server_messages ADD COLUMN parent_id INTEGER')
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute('ALTER TABLE server_messages ADD COLUMN attachment TEXT')
    except sqlite3.OperationalError:
        pass

    # Insert default users if empty
    cursor.execute("SELECT count(*) FROM users WHERE email = 'demis_hassabis@deepmind.com'")
    if cursor.fetchone()[0] == 0:
        mock_users = [
            ("Demis Hassabis", "demis_hassabis@deepmind.com", "https://api.dicebear.com/7.x/bottts/svg?seed=demis"),
            ("Shane Legg", "shane_legg@deepmind.com", "https://api.dicebear.com/7.x/bottts/svg?seed=shane"),
            ("Sundar Pichai", "sundar@google.com", "https://api.dicebear.com/7.x/bottts/svg?seed=sundar"),
            ("David Silver", "david_silver@deepmind.com", "https://api.dicebear.com/7.x/bottts/svg?seed=david"),
            ("Guido van Rossum", "guido@python.org", "https://api.dicebear.com/7.x/bottts/svg?seed=guido"),
            ("Raymond Hettinger", "raymond_hettinger@python.org", "https://api.dicebear.com/7.x/bottts/svg?seed=raymond"),
            ("Łukasz Langa", "lukasz_langa@python.org", "https://api.dicebear.com/7.x/bottts/svg?seed=lukasz"),
            ("Antigravity Bot", "antigravity_bot@ai.com", "https://api.dicebear.com/7.x/bottts/svg?seed=bot")
        ]
        for name, email, avatar in mock_users:
            cursor.execute("INSERT INTO users (name, email, password, avatar) VALUES (?, ?, ?, ?)", (name, email, "mockpassword", avatar))

    # Insert default servers if empty
    cursor.execute("SELECT count(*) FROM servers")
    if cursor.fetchone()[0] == 0:
        cursor.execute("INSERT INTO servers (name, owner_email, icon) VALUES (?, ?, ?)", ("Google DeepMind", "admin@deepmind.com", "GD"))
        cursor.execute("INSERT INTO servers (name, owner_email, icon) VALUES (?, ?, ?)", ("Python Developers", "admin@python.org", "Py"))
        cursor.execute("INSERT INTO servers (name, owner_email, icon) VALUES (?, ?, ?)", ("Antigravity Workspace", "admin@antigravity.com", "AG"))
        
        # Add general channels
        cursor.execute("INSERT INTO server_channels (server_id, name) VALUES (1, 'general')")
        cursor.execute("INSERT INTO server_channels (server_id, name) VALUES (1, 'deepmind-research')")
        cursor.execute("INSERT INTO server_channels (server_id, name) VALUES (2, 'general')")
        cursor.execute("INSERT INTO server_channels (server_id, name) VALUES (2, 'python-help')")
        cursor.execute("INSERT INTO server_channels (server_id, name) VALUES (3, 'general')")
        cursor.execute("INSERT INTO server_channels (server_id, name) VALUES (3, 'antigravity-dev')")

    # Seed mock messages if empty
    cursor.execute("SELECT count(*) FROM server_messages")
    if cursor.fetchone()[0] == 0:
        cursor.execute("SELECT id FROM server_channels")
        channels = cursor.fetchall()
        if channels:
            messages = []
            for ch in channels:
                ch_id = ch[0]
                if ch_id == 1:
                    messages.extend([
                        (1, "demis_hassabis@deepmind.com", "Приветствую всех в сообществе Google DeepMind! Здесь мы делимся новостями о наших разработках."),
                        (1, "shane_legg@deepmind.com", "Всем привет! Кто-нибудь уже тестировал новые модели Gemini 1.5 Flash? Поделитесь впечатлениями!"),
                        (1, "sundar@google.com", "Отличный канал для координации. Будем делиться нашими достижениями в AGI прямо тут.")
                    ])
                elif ch_id == 2:
                    messages.extend([
                        (2, "demis_hassabis@deepmind.com", "Коллеги, мы опубликовали статью по AlphaFold 3 в Nature. Это огромный шаг вперед для молекулярной биологии."),
                        (2, "david_silver@deepmind.com", "Мы также завершили первые тесты AlphaStar для стратегического планирования, результаты превосходные.")
                    ])
                elif ch_id == 3:
                    messages.extend([
                        (3, "guido@python.org", "Добро пожаловать в хаб разработчиков Python! Рад видеть всех сторонников чистого и читаемого кода."),
                        (3, "raymond_hettinger@python.org", "Не забывайте: 'Beautiful is better than ugly.' И пишите списковые включения вместо громоздких циклов!"),
                        (3, "lukasz_langa@python.org", "Мы обновили форматтер Black. Теперь форматирование кода происходит на 15% быстрее.")
                    ])
                elif ch_id == 4:
                    messages.extend([
                        (4, "guido@python.org", "Привет! Подскажите, почему конструкция `x = [[]] * 3; x[0].append(1)` изменяет сразу все вложенные списки?"),
                        (4, "raymond_hettinger@python.org", "Это потому что в Python списки умножаются по ссылке. Используйте списковое включение.")
                    ])
                elif ch_id == 5:
                    messages.extend([
                        (5, "antigravity_bot@ai.com", "Система инициализирована. Виртуальное рабочее пространство Antigravity готово к разработке!"),
                        (5, "admin@antigravity.com", "Отлично, проверим логику группировки сообщений и новые стеклянные панели. Всё выглядит превосходно!")
                    ])
            if messages:
                cursor.executemany("INSERT INTO server_messages (channel_id, sender_email, text) VALUES (?, ?, ?)", messages)

    conn.commit()
    conn.close()

init_db()

# --- HTML, CSS, JS ---
@app.route('/')
def index():
    ip = request.headers.get('X-Forwarded-For', request.remote_addr)
    has_visited = ip in visited_ips
    visited_ips.add(ip)
    
    response = make_response(send_from_directory('.', 'index.html'))
    if has_visited:
        response.set_cookie('ip_visited', 'true', max_age=30*24*60*60)
    return response

@app.route('/<path:path>')
def serve_static(path):
    if os.path.exists(path):
        return send_from_directory('.', path)
    return "Not Found", 404
# --------------------------------------------------

@app.route('/register', methods=['POST'])
def register():
    data = request.json
    name = data.get('name')
    email = data.get('email')
    password = data.get('password')
    g_recaptcha_response = data.get('g_recaptcha_response')

    if not name or not email or not password:
        return jsonify({'error': 'Все поля обязательны'}), 400

    if not g_recaptcha_response:
        return jsonify({'error': 'Пожалуйста, подтвердите капчу'}), 400

    # Verify reCAPTCHA
    verify_url = 'https://www.google.com/recaptcha/api/siteverify'
    secret_key = '6LeIxAcTAAAAAGG-vFI1TnFTxWBYOAOHCc3TXdKs'
    try:
        res = requests.post(verify_url, data={
            'secret': secret_key,
            'response': g_recaptcha_response
        }, timeout=3)
        result = res.json()
        if not result.get('success'):
            return jsonify({'error': 'Капча не пройдена. Пожалуйста, попробуйте снова.'}), 400
    except Exception as e:
        print("Warning: reCAPTCHA verification failed, bypassing:", e)

    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute(
            'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
            (name, email, password)
        )
        conn.commit()
        conn.close()
        return jsonify({'message': 'Пользователь успешно зарегистрирован', 'email': email, 'name': name}), 201
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Пользователь с таким email уже существует'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/login', methods=['POST'])
def login():
    data = request.json
    email = data.get('email')
    password = data.get('password')

    if not email or not password:
        return jsonify({'error': 'Введите email и пароль'}), 400

    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('SELECT id, name, password, email, avatar, bio, phone, birthdate, username FROM users WHERE email = ?', (email,))
        user = cursor.fetchone()
        conn.close()

        if user and user[2] == password:
            return jsonify({
                'message': 'Успешный вход', 
                'name': user[1],
                'email': user[3],
                'avatar': user[4] or '',
                'bio': user[5] or '',
                'phone': user[6] or '',
                'birthdate': user[7] or '',
                'username': user[8] or ''
            }), 200
        else:
            return jsonify({'error': 'Неверный email или пароль'}), 401
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/forgot_password', methods=['POST'])
def forgot_password():
    data = request.json
    email = data.get('email')
    if not email:
        return jsonify({'error': 'Введите email'}), 400
    
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('SELECT id FROM users WHERE email = ?', (email,))
        user = cursor.fetchone()
        conn.close()
        
        if not user:
            return jsonify({'error': 'Пользователь не найден'}), 404
            
        code = str(random.randint(100000, 999999))
        recovery_codes[email] = code
        print(f"[{email}] Recovery code: {code}")
        
        # Send email
        try:
            sender_email = "your_email@gmail.com"
            sender_password = "your_app_password"
            
            msg = MIMEMultipart()
            msg['From'] = sender_email
            msg['To'] = email
            msg['Subject'] = "Восстановление пароля"
            
            body = f"Ваш код для восстановления пароля: {code}\nНикому не сообщайте этот код."
            msg.attach(MIMEText(body, 'plain'))
            
            server = smtplib.SMTP('smtp.gmail.com', 587)
            server.starttls()
            server.login(sender_email, sender_password)
            server.send_message(msg)
            server.quit()
        except Exception as e:
            print(f"Ошибка отправки email: {e}. Код: {code}")
            # Fallback if email fails
            
        return jsonify({'message': 'Код отправлен на почту'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/reset_password', methods=['POST'])
def reset_password():
    data = request.json
    email = data.get('email')
    code = data.get('code')
    new_password = data.get('new_password')
    
    if not email or not code or not new_password:
        return jsonify({'error': 'Все поля обязательны'}), 400
        
    if recovery_codes.get(email) != code:
        return jsonify({'error': 'Неверный код'}), 400
        
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('UPDATE users SET password = ? WHERE email = ?', (new_password, email))
        conn.commit()
        conn.close()
        
        # Clean up
        if email in recovery_codes:
            del recovery_codes[email]
            
        return jsonify({'message': 'Пароль успешно изменен'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/update_profile', methods=['POST'])
def update_profile():
    data = request.json
    email = data.get('email')
    avatar = data.get('avatar')
    bio = data.get('bio')
    phone = data.get('phone')
    name = data.get('name')
    birthdate = data.get('birthdate')
    password = data.get('password')
    username = data.get('username')
    new_email = data.get('new_email')

    if not email:
        return jsonify({'error': 'Email не указан'}), 400

    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        
        if new_email and new_email != email:
            cursor.execute('SELECT id FROM users WHERE email = ?', (new_email,))
            if cursor.fetchone():
                conn.close()
                return jsonify({'error': 'Пользователь с таким email уже существует'}), 400

        update_fields = []
        params = []
        if avatar is not None:
            update_fields.append('avatar = ?')
            params.append(avatar)
        if bio is not None:
            update_fields.append('bio = ?')
            params.append(bio)
        if phone is not None:
            update_fields.append('phone = ?')
            params.append(phone)
        if name is not None:
            update_fields.append('name = ?')
            params.append(name)
        if birthdate is not None:
            update_fields.append('birthdate = ?')
            params.append(birthdate)
        if password: 
            update_fields.append('password = ?')
            params.append(password)
        if username is not None:
            update_fields.append('username = ?')
            params.append(username)
        if new_email is not None:
            update_fields.append('email = ?')
            params.append(new_email)
            
        if update_fields:
            query = f"UPDATE users SET {', '.join(update_fields)} WHERE email = ?"
            params.append(email)
            cursor.execute(query, params)
            
        conn.commit()
        conn.close()
        return jsonify({'message': 'Профиль успешно сохранен'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/upload_avatar', methods=['POST'])
def upload_avatar():
    if 'avatar' not in request.files:
        return jsonify({'error': 'Файл не найден'}), 400
    
    file = request.files['avatar']
    if file.filename == '':
        return jsonify({'error': 'Файл не выбран'}), 400
    
    if file:
        filename = secure_filename(file.filename)
        import time
        filename = f"{int(time.time())}_{filename}"
        file.save(os.path.join(app.config['UPLOAD_FOLDER'], filename))
        
        avatar_url = f"/uploads/{filename}"
        return jsonify({'avatar_url': avatar_url}), 200

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# --- Messenger Routes ---
@app.route('/get_users')
def get_users():
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        # Get users
        cursor.execute('SELECT name, email, avatar FROM users')
        users = cursor.fetchall()
        conn.close()
        
        return jsonify([{
            'name': u[0],
            'email': u[1],
            'avatar': u[2] or ''
        } for u in users]), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/get_active_contacts')
def get_active_contacts():
    email = request.args.get('email')
    if not email:
        return jsonify([])
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        # Find active contacts
        cursor.execute('''
            SELECT DISTINCT u.name, u.email, u.avatar 
            FROM users u
            JOIN messages m ON (u.email = m.sender_email OR u.email = m.recipient_email)
            WHERE (m.sender_email = ? OR m.recipient_email = ?)
            AND u.email != ?
        ''', (email, email, email))
        users = cursor.fetchall()
        conn.close()
        return jsonify([{
            'name': u[0],
            'email': u[1],
            'avatar': u[2] or ''
        } for u in users]), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/send_message', methods=['POST'])
def send_message():
    data = request.json
    sender = data.get('sender_email')
    recipient = data.get('recipient_email')
    text = data.get('text')
    parent_id = data.get('parent_id') # None if not a reply
    attachment = data.get('attachment')
    
    if not sender or not recipient or (not text and not attachment):
        return jsonify({'error': 'Данные неполные'}), 400
    
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('INSERT INTO messages (sender_email, recipient_email, text, parent_id, attachment) VALUES (?, ?, ?, ?, ?)', 
                       (sender, recipient, text or '', parent_id, attachment))
        conn.commit()
        conn.close()
        return jsonify({'status': 'ok'}), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/get_messages')
def get_messages():
    sender = request.args.get('sender_email')
    recipient = request.args.get('recipient_email')
    
    if not sender or not recipient:
        return jsonify({'error': 'Укажите отправителя и получателя'}), 400
        
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        # Fetch chat history
        cursor.execute('''
            SELECT id, sender_email, text, timestamp, parent_id, attachment FROM messages 
            WHERE (sender_email = ? AND recipient_email = ?) 
               OR (sender_email = ? AND recipient_email = ?)
            ORDER BY timestamp ASC
        ''', (sender, recipient, recipient, sender))
        msgs = cursor.fetchall()
        conn.close()
        
        return jsonify([{
            'id': m[0],
            'sender': m[1],
            'text': m[2],
            'time': m[3],
            'parent_id': m[4],
            'attachment': m[5]
        } for m in msgs]), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== OAUTH 2.0 ====================

@app.route('/auth/yandex/login')
def auth_yandex_login():
    url = f"https://oauth.yandex.ru/authorize?response_type=code&client_id={YANDEX_CLIENT_ID}&redirect_uri={REDIRECT_URI_YANDEX}"
    return redirect(url)

@app.route('/auth/yandex/callback')
def auth_yandex_callback():
    code = request.args.get('code')
    if not code:
        return "Ошибка: нет кода авторизации Яндекс", 400
        
    token_url = "https://oauth.yandex.ru/token"
    data = {
        'grant_type': 'authorization_code',
        'code': code,
        'client_id': YANDEX_CLIENT_ID,
        'client_secret': YANDEX_CLIENT_SECRET
    }
    resp = requests.post(token_url, data=data).json()
    if 'error' in resp:
        return f"Ошибка Яндекс (возможно неверные ключи в app.py): {resp.get('error_description', resp['error'])}", 400
        
    access_token = resp.get('access_token')
    
    headers = {'Authorization': f'OAuth {access_token}'}
    user_data = requests.get('https://login.yandex.ru/info?format=json', headers=headers).json()
    
    email = user_data.get('default_email')
    name = user_data.get('real_name') or user_data.get('login')
    avatar_id = user_data.get('default_avatar_id')
    avatar = f"https://avatars.yandex.net/get-yapic/{avatar_id}/islands-200" if avatar_id else ""
    
    if not email:
        email = f"ya_{user_data.get('id')}@yandex.local"
        
    return save_social_user_and_redirect(email, name, avatar)

@app.route('/auth/google/login')
def auth_google_login():
    # Google OAuth
    url = (
        "https://accounts.google.com/o/oauth2/v2/auth"
        f"?response_type=code&client_id={GOOGLE_CLIENT_ID}"
        f"&redirect_uri={REDIRECT_URI_GOOGLE}"
        "&scope=openid%20profile%20email"
    )
    return redirect(url)

@app.route('/auth/google/callback')
def auth_google_callback():
    code = request.args.get('code')
    if not code:
        return "Ошибка: нет кода авторизации Google", 400
        
    token_url = "https://oauth2.googleapis.com/token"
    data = {
        'code': code,
        'client_id': GOOGLE_CLIENT_ID,
        'client_secret': GOOGLE_CLIENT_SECRET,
        'redirect_uri': REDIRECT_URI_GOOGLE,
        'grant_type': 'authorization_code'
    }
    resp = requests.post(token_url, data=data).json()
    if 'error' in resp:
        return f"Ошибка Google: {resp.get('error_description', resp['error'])}", 400
        
    access_token = resp.get('access_token')
    
    # User data
    user_info_url = "https://www.googleapis.com/oauth2/v3/userinfo"
    headers = {'Authorization': f'Bearer {access_token}'}
    user_data = requests.get(user_info_url, headers=headers).json()
    
    email = user_data.get('email')
    name = user_data.get('name')
    avatar = user_data.get('picture')
    
    if not email:
        return "Ошибка: Google не вернул email", 400
        
    return save_social_user_and_redirect(email, name, avatar)

def save_social_user_and_redirect(email, name, avatar):
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT id, name, email, avatar, bio, phone, birthdate, username FROM users WHERE email = ?', (email,))
    existing = cursor.fetchone()
    
    if existing:
        db_avatar = existing[3] or avatar
        bio = existing[4] or ''
        phone = existing[5] or ''
        birthdate = existing[6] or ''
        username = existing[7] or ''
    else:
        cursor.execute('INSERT INTO users (name, email, avatar) VALUES (?, ?, ?)', (name, email, avatar))
        conn.commit()
        db_avatar = avatar
        bio = ''
        phone = ''
        birthdate = ''
        username = ''
        
    conn.close()
    
    html = f"""
    <html><body>
    <script>
        const userData = {{
            name: "{name}",
            email: "{email}",
            avatar: "{db_avatar}",
            bio: "{bio}",
            phone: "{phone}",
            birthdate: "{birthdate}",
            username: "{username}"
        }};
        if (window.opener) {{
            window.opener.postMessage({{ type: 'OAUTH_SUCCESS', user: userData }}, '*');
            window.close();
        }} else {{
            localStorage.setItem('oauth_user', JSON.stringify(userData));
            window.location.href = '/';
        }}
    </script>
    </body></html>
    """
    return html


# --- Servers and Channels API ---

@app.route('/api/servers', methods=['GET'])
def get_servers():
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('SELECT id, name, owner_email, icon FROM servers')
        servers = cursor.fetchall()
        
        result = []
        for s in servers:
            cursor.execute('SELECT id, name FROM server_channels WHERE server_id = ?', (s[0],))
            channels = cursor.fetchall()
            result.append({
                'id': s[0],
                'name': s[1],
                'owner_email': s[2],
                'icon': s[3],
                'channels': [{'id': ch[0], 'name': ch[1]} for ch in channels]
            })
        conn.close()
        return jsonify(result), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/servers', methods=['POST'])
def create_server():
    data = request.json
    name = data.get('name')
    owner_email = data.get('owner_email')
    icon = data.get('icon', '')
    if not name or not owner_email:
        return jsonify({'error': 'Название сервера обязательно'}), 400
    
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('INSERT INTO servers (name, owner_email, icon) VALUES (?, ?, ?)', (name, owner_email, icon))
        server_id = cursor.lastrowid
        
        # Automatically create a general channel
        cursor.execute('INSERT INTO server_channels (server_id, name) VALUES (?, ?)', (server_id, 'general'))
        conn.commit()
        conn.close()
        return jsonify({'message': 'Сервер создан', 'id': server_id, 'name': name}), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/servers/<int:server_id>', methods=['DELETE'])
def delete_server(server_id):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        
        # Get all channels for this server to delete their messages first
        cursor.execute('SELECT id FROM server_channels WHERE server_id = ?', (server_id,))
        channels = cursor.fetchall()
        for ch in channels:
            cursor.execute('DELETE FROM server_messages WHERE channel_id = ?', (ch[0],))
            
        cursor.execute('DELETE FROM server_channels WHERE server_id = ?', (server_id,))
        cursor.execute('DELETE FROM servers WHERE id = ?', (server_id,))
        conn.commit()
        conn.close()
        return jsonify({'message': 'Сервер успешно удален'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/servers/<int:server_id>', methods=['PUT'])
def update_server(server_id):
    data = request.json
    name = data.get('name')
    icon = data.get('icon')
    if not name:
        return jsonify({'error': 'Название сервера обязательно'}), 400
        
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('UPDATE servers SET name = ?, icon = ? WHERE id = ?', (name, icon, server_id))
        conn.commit()
        conn.close()
        return jsonify({'message': 'Сервер успешно обновлен'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/channels/<int:channel_id>/messages', methods=['GET'])
def get_channel_messages(channel_id):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('''
            SELECT sm.id, sm.sender_email, sm.text, sm.timestamp, u.name, u.avatar, sm.parent_id, sm.attachment
            FROM server_messages sm
            LEFT JOIN users u ON sm.sender_email = u.email
            WHERE sm.channel_id = ?
            ORDER BY sm.timestamp ASC
        ''', (channel_id,))
        msgs = cursor.fetchall()
        conn.close()
        
        result = []
        for m in msgs:
            result.append({
                'id': m[0],
                'sender': m[1],
                'text': m[2],
                'time': m[3],
                'sender_name': m[4] or m[1].split('@')[0],
                'sender_avatar': m[5] or '',
                'parent_id': m[6],
                'attachment': m[7]
            })
        return jsonify(result), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/channels/<int:channel_id>/messages', methods=['POST'])
def send_channel_message(channel_id):
    data = request.json
    sender_email = data.get('sender_email')
    text = data.get('text')
    parent_id = data.get('parent_id')
    attachment = data.get('attachment')
    if not sender_email or (not text and not attachment):
        return jsonify({'error': 'Неполные данные'}), 400
        
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('INSERT INTO server_messages (channel_id, sender_email, text, parent_id, attachment) VALUES (?, ?, ?, ?, ?)', 
                       (channel_id, sender_email, text or '', parent_id, attachment))
        conn.commit()
        conn.close()
        return jsonify({'message': 'Сообщение отправлено'}), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# Message edit & delete endpoints
@app.route('/api/messages/<int:msg_id>', methods=['PUT'])
def edit_direct_message(msg_id):
    data = request.json
    text = data.get('text')
    if not text:
        return jsonify({'error': 'Текст сообщения обязателен'}), 400
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('UPDATE messages SET text = ? WHERE id = ?', (text, msg_id))
        conn.commit()
        conn.close()
        return jsonify({'message': 'Сообщение обновлено'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/messages/<int:msg_id>', methods=['DELETE'])
def delete_direct_message(msg_id):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('DELETE FROM messages WHERE id = ?', (msg_id,))
        conn.commit()
        conn.close()
        return jsonify({'message': 'Сообщение удалено'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/channels/<int:channel_id>/messages/<int:msg_id>', methods=['PUT'])
def edit_channel_message(channel_id, msg_id):
    data = request.json
    text = data.get('text')
    if not text:
        return jsonify({'error': 'Текст сообщения обязателен'}), 400
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('UPDATE server_messages SET text = ? WHERE id = ? AND channel_id = ?', (text, msg_id, channel_id))
        conn.commit()
        conn.close()
        return jsonify({'message': 'Сообщение обновлено'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/channels/<int:channel_id>/messages/<int:msg_id>', methods=['DELETE'])
def delete_channel_message(channel_id, msg_id):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('DELETE FROM server_messages WHERE id = ? AND channel_id = ?', (msg_id, channel_id))
        conn.commit()
        conn.close()
        return jsonify({'message': 'Сообщение удалено'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/upload_attachment', methods=['POST'])
def upload_attachment():
    if 'file' not in request.files:
        return jsonify({'error': 'Файл не найден'}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Файл не выбран'}), 400
        
    if file:
        filename = secure_filename(file.filename)
        import time
        filename = f"{int(time.time())}_{filename}"
        file.save(os.path.join(app.config['UPLOAD_FOLDER'], filename))
        
        file_url = f"/uploads/{filename}"
        return jsonify({
            'file_url': file_url,
            'filename': file.filename
        }), 200


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
