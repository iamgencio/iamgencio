<?php
declare(strict_types=1);

namespace Nyota;

final class AuthController
{
    public static function register(): array
    {
        $b = Http::body();
        Http::require($b, ['name', 'email', 'password']);
        $email = strtolower(trim((string) $b['email']));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) throw new HttpError(422, 'Email invalide');
        if (strlen((string) $b['password']) < 8) throw new HttpError(422, 'Mot de passe : 8 caractères minimum');
        if (Db::one('SELECT 1 FROM users WHERE email = ?', [$email])) throw new HttpError(409, 'Cet email est déjà utilisé');
        $role = ($b['role'] ?? '') === 'creator' ? 'creator' : 'reader';
        $id = Db::insert('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)',
            [trim((string) $b['name']), $email, password_hash((string) $b['password'], PASSWORD_DEFAULT), $role]);
        $u = Db::one('SELECT id, name, email, role FROM users WHERE id = ?', [$id]);
        return ['token' => Auth::token($u), 'user' => $u + ['premium' => false]];
    }

    public static function login(): array
    {
        $b = Http::body();
        Http::require($b, ['email', 'password']);
        $row = Db::one('SELECT * FROM users WHERE email = ?', [strtolower(trim((string) $b['email']))]);
        if (!$row || !password_verify((string) $b['password'], $row['password_hash'])) {
            throw new HttpError(401, 'Identifiants incorrects');
        }
        $u = ['id' => $row['id'], 'name' => $row['name'], 'email' => $row['email'], 'role' => $row['role']];
        return ['token' => Auth::token($u), 'user' => $u + ['premium' => Auth::isPremium($u)]];
    }

    public static function me(): array
    {
        $u = Auth::require();
        $sub = Db::one('SELECT ends_at FROM subscriptions WHERE user_id = ? AND ends_at > NOW() ORDER BY ends_at DESC LIMIT 1', [$u['id']]);
        return ['user' => $u + ['premium' => Auth::isPremium($u), 'premium_until' => $sub['ends_at'] ?? null]];
    }
}

final class CatalogController
{
    private const CARD = "s.id, s.slug, s.title, s.author, s.type, s.country, s.cover_url, s.accent, s.status, s.views,
        (SELECT COUNT(*) FROM chapters c WHERE c.series_id = s.id) AS chapter_count";

    private static function withGenres(array $rows): array
    {
        if (!$rows) return $rows;
        $ids = array_column($rows, 'id');
        $in = implode(',', array_fill(0, count($ids), '?'));
        $g = Db::all("SELECT sg.series_id, g.slug, g.name FROM series_genres sg JOIN genres g ON g.id = sg.genre_id WHERE sg.series_id IN ($in)", $ids);
        $map = [];
        foreach ($g as $r) $map[$r['series_id']][] = ['slug' => $r['slug'], 'name' => $r['name']];
        foreach ($rows as &$r) $r['genres'] = $map[$r['id']] ?? [];
        return $rows;
    }

    private static function list(string $where, array $p, string $order, int $limit): array
    {
        return self::withGenres(Db::all(
            "SELECT " . self::CARD . " FROM series s WHERE s.publish_status = 'published' $where ORDER BY $order LIMIT $limit", $p));
    }

    public static function home(): array
    {
        $featured = self::list('AND s.is_featured = 1', [], 's.updated_at DESC', 5);
        return [
            'featured' => $featured,
            'rows' => [
                ['key' => 'trending', 'title' => 'Tendances du moment', 'items' => self::list('', [], 's.views DESC', 18)],
                ['key' => 'african', 'title' => 'BD africaines', 'items' => self::list("AND s.type = 'bd_africaine'", [], 's.views DESC', 18)],
                ['key' => 'new', 'title' => 'Nouveautés', 'items' => self::list('', [], 's.created_at DESC', 18)],
                ['key' => 'manga', 'title' => 'Mangas', 'items' => self::list("AND s.type = 'manga'", [], 's.views DESC', 18)],
                ['key' => 'manhwa', 'title' => 'Manhwas', 'items' => self::list("AND s.type = 'manhwa'", [], 's.views DESC', 18)],
            ],
        ];
    }

    public static function genres(): array
    {
        return ['genres' => Db::all('SELECT slug, name FROM genres ORDER BY name')];
    }

    public static function browse(): array
    {
        $q = $_GET;
        $where = '';
        $p = [];
        if (!empty($q['type'])) { $where .= ' AND s.type = ?'; $p[] = $q['type']; }
        if (!empty($q['genre'])) {
            $where .= ' AND EXISTS (SELECT 1 FROM series_genres sg JOIN genres g ON g.id = sg.genre_id WHERE sg.series_id = s.id AND g.slug = ?)';
            $p[] = $q['genre'];
        }
        if (!empty($q['q'])) {
            $where .= ' AND (s.title LIKE ? OR s.author LIKE ?)';
            $like = '%' . addcslashes((string) $q['q'], '%_') . '%';
            array_push($p, $like, $like);
        }
        $order = match ($q['sort'] ?? 'popular') { 'new' => 's.created_at DESC', 'az' => 's.title ASC', default => 's.views DESC' };
        $page = max(1, (int) ($q['page'] ?? 1));
        $per = 24;
        $total = (int) Db::one("SELECT COUNT(*) n FROM series s WHERE s.publish_status = 'published' $where", $p)['n'];
        $items = self::withGenres(Db::all(
            "SELECT " . self::CARD . " FROM series s WHERE s.publish_status = 'published' $where ORDER BY $order LIMIT $per OFFSET " . (($page - 1) * $per), $p));
        return ['items' => $items, 'total' => $total, 'page' => $page, 'pages' => (int) ceil($total / $per)];
    }

    public static function show(array $a): array
    {
        $s = Db::one("SELECT s.*, " . self::CARD . " FROM series s WHERE s.slug = ? AND s.publish_status = 'published'", [$a['slug']]);
        if (!$s) throw new HttpError(404, 'Série introuvable');
        Db::run('UPDATE series SET views = views + 1 WHERE id = ?', [$s['id']]);
        $s = self::withGenres([$s])[0];
        $s['chapters'] = Db::all('SELECT id, number, title, is_premium, published_at FROM chapters WHERE series_id = ? ORDER BY number DESC', [$s['id']]);
        $u = Auth::user();
        $s['is_favorite'] = $u ? (bool) Db::one('SELECT 1 FROM favorites WHERE user_id = ? AND series_id = ?', [$u['id'], $s['id']]) : false;
        $s['last_read'] = $u ? Db::one('SELECT chapter_id, page FROM reading_history WHERE user_id = ? AND series_id = ? ORDER BY updated_at DESC LIMIT 1', [$u['id'], $s['id']]) : null;
        unset($s['creator_id']);
        return $s;
    }

    public static function chapter(array $a): array
    {
        $c = Db::one("SELECT c.*, s.slug AS series_slug, s.title AS series_title, s.accent FROM chapters c
            JOIN series s ON s.id = c.series_id WHERE c.id = ? AND s.publish_status = 'published'", [$a['id']]);
        if (!$c) throw new HttpError(404, 'Chapitre introuvable');
        $u = Auth::user();
        $locked = (bool) $c['is_premium'] && !Auth::isPremium($u);
        $pages = Db::all('SELECT position, image_url FROM pages WHERE chapter_id = ? ORDER BY position', [$c['id']]);
        $c['total_pages'] = count($pages);
        $c['locked'] = $locked;
        $c['pages'] = $locked ? array_slice($pages, 0, 2) : $pages; // aperçu de 2 pages
        $c['prev_id'] = Db::one('SELECT id FROM chapters WHERE series_id = ? AND number < ? ORDER BY number DESC LIMIT 1', [$c['series_id'], $c['number']])['id'] ?? null;
        $c['next_id'] = Db::one('SELECT id FROM chapters WHERE series_id = ? AND number > ? ORDER BY number ASC LIMIT 1', [$c['series_id'], $c['number']])['id'] ?? null;
        return $c;
    }
}

final class LibraryController
{
    public static function index(): array
    {
        $u = Auth::require();
        $fav = Db::all("SELECT s.id, s.slug, s.title, s.author, s.type, s.cover_url, s.accent FROM favorites f JOIN series s ON s.id = f.series_id
            WHERE f.user_id = ? AND s.publish_status = 'published' ORDER BY f.created_at DESC", [$u['id']]);
        $hist = Db::all("SELECT s.id, s.slug, s.title, s.type, s.cover_url, s.accent, c.id AS chapter_id, c.number, h.page, h.updated_at
            FROM reading_history h JOIN chapters c ON c.id = h.chapter_id JOIN series s ON s.id = h.series_id
            WHERE h.user_id = ? ORDER BY h.updated_at DESC LIMIT 30", [$u['id']]);
        return ['favorites' => $fav, 'history' => $hist];
    }

    public static function addFavorite(array $a): array
    {
        $u = Auth::require();
        Db::run('INSERT IGNORE INTO favorites (user_id, series_id) VALUES (?,?)', [$u['id'], (int) $a['id']]);
        return ['ok' => true];
    }

    public static function removeFavorite(array $a): array
    {
        $u = Auth::require();
        Db::run('DELETE FROM favorites WHERE user_id = ? AND series_id = ?', [$u['id'], (int) $a['id']]);
        return ['ok' => true];
    }

    public static function progress(array $a): array
    {
        $u = Auth::require();
        $page = max(1, (int) (Http::body()['page'] ?? 1));
        $c = Db::one('SELECT id, series_id FROM chapters WHERE id = ?', [$a['id']]);
        if (!$c) throw new HttpError(404, 'Chapitre introuvable');
        Db::run('INSERT INTO reading_history (user_id, chapter_id, series_id, page) VALUES (?,?,?,?)
            ON DUPLICATE KEY UPDATE page = VALUES(page), updated_at = NOW()', [$u['id'], $c['id'], $c['series_id'], $page]);
        return ['ok' => true];
    }
}

final class PaymentController
{
    public static function plans(): array
    {
        $plans = Db::all('SELECT id, code, name, price_xof, duration_days, perks FROM plans WHERE active = 1 ORDER BY price_xof');
        foreach ($plans as &$p) $p['perks'] = array_values(array_filter(explode('|', (string) $p['perks'])));
        return ['plans' => $plans, 'networks' => FeexPay::NETWORKS, 'mode' => FeexPay::mode()];
    }

    public static function checkout(): array
    {
        $u = Auth::require();
        $b = Http::body();
        Http::require($b, ['plan_id', 'network', 'phone']);
        if (!isset(FeexPay::NETWORKS[$b['network']])) throw new HttpError(422, 'Moyen de paiement inconnu');
        $phone = preg_replace('/[^0-9]/', '', (string) $b['phone']);
        if (strlen($phone) < 8) throw new HttpError(422, 'Numéro de téléphone invalide');
        $plan = Db::one('SELECT * FROM plans WHERE id = ? AND active = 1', [(int) $b['plan_id']]);
        if (!$plan) throw new HttpError(404, 'Formule introuvable');

        $ref = 'NYO-' . strtoupper(bin2hex(random_bytes(6)));
        $payId = Db::insert('INSERT INTO payments (reference, user_id, plan_id, amount_xof, network, phone) VALUES (?,?,?,?,?,?)',
            [$ref, $u['id'], $plan['id'], $plan['price_xof'], $b['network'], $phone]);
        try {
            $r = FeexPay::requestToPay($ref, (int) $plan['price_xof'], $b['network'], $phone, $u, "Nyota Scans — {$plan['name']}");
        } catch (HttpError $e) {
            Db::run("UPDATE payments SET status = 'failed' WHERE id = ?", [$payId]);
            throw $e;
        }
        Db::run('UPDATE payments SET provider_ref = ? WHERE id = ?', [$r['provider_ref'], $payId]);
        if ($r['status'] === 'success') self::settle($payId);
        return ['reference' => $ref, 'status' => $r['status']];
    }

    public static function status(array $a): array
    {
        $u = Auth::require();
        $p = Db::one('SELECT * FROM payments WHERE reference = ? AND user_id = ?', [$a['ref'], $u['id']]);
        if (!$p) throw new HttpError(404, 'Paiement introuvable');
        if ($p['status'] === 'pending' && $p['provider_ref']) {
            $st = FeexPay::status($p['provider_ref']);
            if ($st === 'success') self::settle((int) $p['id']);
            elseif ($st === 'failed') Db::run("UPDATE payments SET status = 'failed' WHERE id = ?", [$p['id']]);
            $p['status'] = $st;
        }
        return ['reference' => $p['reference'], 'status' => $p['status']];
    }

    /** Webhook FeexPay : on ne fait jamais confiance au corps, on revérifie le statut auprès du fournisseur. */
    public static function webhook(): array
    {
        $secret = Config::get('FEEXPAY_WEBHOOK_SECRET');
        if ($secret !== '' && !hash_equals($secret, (string) ($_GET['secret'] ?? ''))) throw new HttpError(403, 'Signature invalide');
        $b = Http::body();
        $ref = (string) ($b['callback_info'] ?? $b['reference'] ?? '');
        $p = Db::one('SELECT * FROM payments WHERE reference = ? OR provider_ref = ?', [$ref, $ref]);
        if ($p && $p['status'] === 'pending') {
            $st = FeexPay::status($p['provider_ref'] ?: $p['reference']);
            if ($st === 'success') self::settle((int) $p['id']);
            elseif ($st === 'failed') Db::run("UPDATE payments SET status = 'failed' WHERE id = ?", [$p['id']]);
        }
        return ['ok' => true];
    }

    /** Valide le paiement une seule fois et prolonge l'abonnement. */
    private static function settle(int $paymentId): void
    {
        $pdo = Db::pdo();
        $pdo->beginTransaction();
        try {
            $p = Db::one("SELECT * FROM payments WHERE id = ? FOR UPDATE", [$paymentId]);
            if (!$p || $p['status'] === 'success') { $pdo->commit(); return; }
            $plan = Db::one('SELECT * FROM plans WHERE id = ?', [$p['plan_id']]);
            $cur = Db::one('SELECT MAX(ends_at) e FROM subscriptions WHERE user_id = ? AND ends_at > NOW()', [$p['user_id']]);
            $start = $cur && $cur['e'] ? $cur['e'] : date('Y-m-d H:i:s');
            Db::run("UPDATE payments SET status = 'success' WHERE id = ?", [$paymentId]);
            Db::run('INSERT INTO subscriptions (user_id, plan_id, payment_id, starts_at, ends_at) VALUES (?,?,?,?, DATE_ADD(?, INTERVAL ? DAY))',
                [$p['user_id'], $p['plan_id'], $paymentId, $start, $start, (int) $plan['duration_days']]);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }
}

final class CreatorController
{
    private const TYPES = ['manga', 'manhwa', 'bd_africaine', 'comic'];

    public static function mySeries(): array
    {
        $u = Auth::require('creator', 'admin');
        return ['items' => Db::all("SELECT s.id, s.slug, s.title, s.type, s.cover_url, s.accent, s.publish_status, s.views,
            (SELECT COUNT(*) FROM chapters c WHERE c.series_id = s.id) AS chapter_count FROM series s WHERE s.creator_id = ? ORDER BY s.created_at DESC", [$u['id']])];
    }

    public static function createSeries(): array
    {
        $u = Auth::require('creator', 'admin');
        $b = Http::body();
        Http::require($b, ['title', 'synopsis']);
        $type = in_array($b['type'] ?? '', self::TYPES, true) ? $b['type'] : 'bd_africaine';
        $slug = Http::slug((string) $b['title']);
        if (Db::one('SELECT 1 FROM series WHERE slug = ?', [$slug])) $slug .= '-' . substr(bin2hex(random_bytes(2)), 0, 4);
        $id = Db::insert('INSERT INTO series (slug, title, author, synopsis, type, country, cover_url, creator_id, publish_status) VALUES (?,?,?,?,?,?,?,?,?)',
            [$slug, trim((string) $b['title']), trim((string) ($b['author'] ?? $u['name'])), trim((string) $b['synopsis']), $type,
             $b['country'] ?? null, $b['cover_url'] ?? null, $u['id'], 'draft']);
        foreach ((array) ($b['genres'] ?? []) as $g) {
            Db::run('INSERT IGNORE INTO series_genres (series_id, genre_id) SELECT ?, id FROM genres WHERE slug = ?', [$id, $g]);
        }
        return ['id' => $id, 'slug' => $slug];
    }

    public static function submit(array $a): array
    {
        $u = Auth::require('creator', 'admin');
        $n = Db::run("UPDATE series SET publish_status = 'pending' WHERE id = ? AND creator_id = ? AND publish_status = 'draft'", [(int) $a['id'], $u['id']]);
        if (!$n) throw new HttpError(409, 'Impossible de soumettre cette série');
        return ['ok' => true];
    }

    public static function uploadCover(array $a): array
    {
        $u = Auth::require('creator', 'admin');
        $s = Db::one('SELECT id FROM series WHERE id = ? AND (creator_id = ? OR ? = "admin")', [(int) $a['id'], $u['id'], $u['role']]);
        if (!$s) throw new HttpError(404, 'Série introuvable');
        $url = self::saveImage($_FILES['cover'] ?? null);
        Db::run('UPDATE series SET cover_url = ? WHERE id = ?', [$url, $s['id']]);
        return ['cover_url' => $url];
    }

    public static function addChapter(array $a): array
    {
        $u = Auth::require('creator', 'admin');
        $s = Db::one('SELECT id FROM series WHERE id = ? AND (creator_id = ? OR ? = "admin")', [(int) $a['id'], $u['id'], $u['role']]);
        if (!$s) throw new HttpError(404, 'Série introuvable');
        $b = Http::body();
        Http::require($b, ['number']);
        $files = $_FILES['pages'] ?? null;
        if (!$files || !is_array($files['name'])) throw new HttpError(422, 'Ajoutez au moins une page (champ pages[])');
        $pdo = Db::pdo();
        $pdo->beginTransaction();
        try {
            $cid = Db::insert('INSERT INTO chapters (series_id, number, title, is_premium) VALUES (?,?,?,?)',
                [$s['id'], (float) $b['number'], $b['title'] ?? null, !empty($b['is_premium']) ? 1 : 0]);
            $names = $files['name'];
            array_multisort($names, SORT_NATURAL | SORT_FLAG_CASE, $files['tmp_name'], $files['error'], $files['size']);
            foreach ($files['tmp_name'] as $i => $tmp) {
                $url = self::saveImage(['tmp_name' => $tmp, 'error' => $files['error'][$i], 'size' => $files['size'][$i]]);
                Db::run('INSERT INTO pages (chapter_id, position, image_url) VALUES (?,?,?)', [$cid, $i + 1, $url]);
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            if ($e instanceof \PDOException && $e->getCode() === '23000') throw new HttpError(409, 'Ce numéro de chapitre existe déjà');
            throw $e;
        }
        return ['id' => $cid];
    }

    private static function saveImage(?array $f): string
    {
        if (!$f || ($f['error'] ?? 1) !== UPLOAD_ERR_OK) throw new HttpError(422, "Échec de l'envoi du fichier");
        if ($f['size'] > 8 * 1024 * 1024) throw new HttpError(413, 'Image trop lourde (8 Mo max)');
        $mime = (new \finfo(FILEINFO_MIME_TYPE))->file($f['tmp_name']);
        $ext = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'][$mime] ?? null;
        if (!$ext) throw new HttpError(415, 'Formats acceptés : JPG, PNG, WebP');
        $dir = dirname(__DIR__) . '/storage/uploads/' . date('Y/m');
        if (!is_dir($dir)) mkdir($dir, 0775, true);
        $name = bin2hex(random_bytes(10)) . '.' . $ext;
        if (!move_uploaded_file($f['tmp_name'], "$dir/$name")) throw new HttpError(500, "Impossible d'enregistrer le fichier");
        return rtrim(Config::get('APP_URL'), '/') . '/uploads/' . date('Y/m') . '/' . $name;
    }
}

final class AdminController
{
    public static function stats(): array
    {
        Auth::require('admin');
        return [
            'users' => (int) Db::one('SELECT COUNT(*) n FROM users')['n'],
            'series' => (int) Db::one("SELECT COUNT(*) n FROM series WHERE publish_status = 'published'")['n'],
            'pending' => (int) Db::one("SELECT COUNT(*) n FROM series WHERE publish_status = 'pending'")['n'],
            'subscribers' => (int) Db::one('SELECT COUNT(DISTINCT user_id) n FROM subscriptions WHERE ends_at > NOW()')['n'],
            'revenue_xof' => (int) (Db::one("SELECT COALESCE(SUM(amount_xof),0) n FROM payments WHERE status = 'success'")['n']),
        ];
    }

    public static function queue(): array
    {
        Auth::require('admin');
        return ['items' => Db::all("SELECT s.id, s.slug, s.title, s.author, s.type, s.cover_url, s.publish_status, u.name AS creator
            FROM series s LEFT JOIN users u ON u.id = s.creator_id WHERE s.publish_status <> 'draft' ORDER BY (s.publish_status = 'pending') DESC, s.updated_at DESC LIMIT 100")];
    }

    public static function setStatus(array $a): array
    {
        Auth::require('admin');
        $b = Http::body();
        if (!in_array($b['publish_status'] ?? '', ['draft', 'pending', 'published'], true)) throw new HttpError(422, 'Statut invalide');
        Db::run('UPDATE series SET publish_status = ?, is_featured = COALESCE(?, is_featured) WHERE id = ?',
            [$b['publish_status'], isset($b['is_featured']) ? (int) (bool) $b['is_featured'] : null, (int) $a['id']]);
        return ['ok' => true];
    }
}
