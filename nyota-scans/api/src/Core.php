<?php
declare(strict_types=1);

namespace Nyota;

final class Config
{
    private static array $env = [];

    public static function load(string $file): void
    {
        if (is_file($file)) {
            foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                if ($line[0] === '#' || !str_contains($line, '=')) continue;
                [$k, $v] = explode('=', $line, 2);
                self::$env[trim($k)] = trim($v);
            }
        }
    }

    public static function get(string $key, string $default = ''): string
    {
        return $_ENV[$key] ?? getenv($key) ?: (self::$env[$key] ?? $default);
    }
}

final class Db
{
    private static ?\PDO $pdo = null;

    public static function pdo(): \PDO
    {
        if (self::$pdo === null) {
            $dsn = sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
                Config::get('DB_HOST', '127.0.0.1'), Config::get('DB_PORT', '3306'), Config::get('DB_NAME', 'nyota'));
            self::$pdo = new \PDO($dsn, Config::get('DB_USER', 'root'), Config::get('DB_PASS'), [
                \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
                \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
                \PDO::ATTR_EMULATE_PREPARES => false,
            ]);
        }
        return self::$pdo;
    }

    public static function all(string $sql, array $p = []): array
    {
        $s = self::pdo()->prepare($sql);
        $s->execute($p);
        return $s->fetchAll();
    }

    public static function one(string $sql, array $p = []): ?array
    {
        $s = self::pdo()->prepare($sql);
        $s->execute($p);
        $r = $s->fetch();
        return $r === false ? null : $r;
    }

    public static function run(string $sql, array $p = []): int
    {
        $s = self::pdo()->prepare($sql);
        $s->execute($p);
        return $s->rowCount();
    }

    public static function insert(string $sql, array $p = []): int
    {
        self::run($sql, $p);
        return (int) self::pdo()->lastInsertId();
    }
}

final class HttpError extends \RuntimeException
{
    public function __construct(public int $status, string $message, public array $extra = [])
    {
        parent::__construct($message);
    }
}

final class Http
{
    public static function json(mixed $data, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    public static function body(): array
    {
        static $body = null;
        if ($body === null) {
            $raw = file_get_contents('php://input') ?: '';
            $body = json_decode($raw, true);
            if (!is_array($body)) $body = $_POST;
        }
        return $body;
    }

    public static function require(array $data, array $fields): void
    {
        foreach ($fields as $f) {
            if (!isset($data[$f]) || $data[$f] === '') throw new HttpError(422, "Champ requis : $f");
        }
    }

    public static function slug(string $s): string
    {
        $s = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s) ?: $s;
        $s = strtolower(trim(preg_replace('/[^A-Za-z0-9]+/', '-', $s), '-'));
        return $s !== '' ? $s : bin2hex(random_bytes(4));
    }
}

final class Jwt
{
    private static function b64(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
    private static function unb64(string $s): string { return base64_decode(strtr($s, '-_', '+/')) ?: ''; }

    public static function encode(array $claims, int $ttl = 60 * 60 * 24 * 30): string
    {
        $claims['exp'] = time() + $ttl;
        $h = self::b64(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
        $p = self::b64(json_encode($claims));
        $sig = self::b64(hash_hmac('sha256', "$h.$p", Config::get('APP_SECRET', 'dev-secret'), true));
        return "$h.$p.$sig";
    }

    public static function decode(string $jwt): ?array
    {
        $parts = explode('.', $jwt);
        if (count($parts) !== 3) return null;
        [$h, $p, $s] = $parts;
        $expected = self::b64(hash_hmac('sha256', "$h.$p", Config::get('APP_SECRET', 'dev-secret'), true));
        if (!hash_equals($expected, $s)) return null;
        $claims = json_decode(self::unb64($p), true);
        if (!is_array($claims) || ($claims['exp'] ?? 0) < time()) return null;
        return $claims;
    }
}

final class Auth
{
    public static function user(): ?array
    {
        static $cached = false;
        if ($cached !== false) return $cached;
        $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        $cached = null;
        if (preg_match('/^Bearer\s+(.+)$/i', $h, $m) && ($c = Jwt::decode($m[1]))) {
            $cached = Db::one('SELECT id, name, email, role FROM users WHERE id = ?', [$c['sub']]);
        }
        return $cached;
    }

    public static function require(string ...$roles): array
    {
        $u = self::user();
        if (!$u) throw new HttpError(401, 'Connexion requise');
        if ($roles && !in_array($u['role'], $roles, true)) throw new HttpError(403, 'Accès refusé');
        return $u;
    }

    public static function isPremium(?array $u): bool
    {
        if (!$u) return false;
        if ($u['role'] === 'admin') return true;
        return (bool) Db::one('SELECT 1 FROM subscriptions WHERE user_id = ? AND ends_at > NOW() LIMIT 1', [$u['id']]);
    }

    public static function token(array $u): string
    {
        return Jwt::encode(['sub' => (int) $u['id']]);
    }
}

final class Router
{
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler): void
    {
        $regex = '#^' . preg_replace('#\{(\w+)\}#', '(?P<$1>[^/]+)', $pattern) . '$#';
        $this->routes[] = [$method, $regex, $handler];
    }

    public function dispatch(string $method, string $path): void
    {
        $allowed = false;
        foreach ($this->routes as [$m, $regex, $handler]) {
            if (preg_match($regex, $path, $mm)) {
                if ($m !== $method) { $allowed = true; continue; }
                $params = array_filter($mm, 'is_string', ARRAY_FILTER_USE_KEY);
                Http::json($handler($params));
            }
        }
        throw new HttpError($allowed ? 405 : 404, $allowed ? 'Méthode non autorisée' : 'Introuvable');
    }
}
