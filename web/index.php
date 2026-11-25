<?php
/**
 * Phira Web —— PHP 版服务器后端
 *
 * 这是本地 web/serve.py 的服务器版本，职责完全一致：
 *
 *   1. 静态文件：给出正确的 MIME（尤其是 application/wasm），并附上
 *      no-cache / nosniff / inline 响应头，避免 IDM 之类的下载管理器
 *      把 .wasm / .ogg / .ttf 当成附件抢去下载。
 *   2. /__res?p=assets/button.ogg   —— 无扩展名资源出口。
 *      下载管理器通常按 URL 扩展名判定是否拦截，这里用无扩展名路径
 *      配 text/plain 送出原始字节，浏览器拿到的仍是源文件。
 *   3. /__proxy?url=https://...     —— 同源代理。
 *      浏览器直连 Phira 官方 API 会被 CORS 拦下（登录 / 排行 / 谱面下载
 *      都需要它），前端把跨域请求改写成 /__proxy?url=... 交给这里转发。
 *
 * 部署：把本文件与 index.html / gl.js / host.js / pkg / assets 一起放在
 * 网站根目录，然后让 Web 服务器把请求都转给本文件（见 .htaccess 与
 * README 里的 nginx 配置片段）。
 *
 * 注意：前端把入口硬编码成站内绝对路径 /__res 与 /__proxy，
 * 因此本站建议部署在域名根目录（https://你的域名/），不要放子目录。
 */

declare(strict_types=1);

// 不要让 PHP 的错误/警告混进二进制响应里，否则 wasm 会解析失败。
@ini_set('display_errors', '0');
@ini_set('log_errors', '1');
@ini_set('zlib.output_compression', '0');
@ini_set('output_buffering', '0');
error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE);

$ROOT = realpath(__DIR__);
if ($ROOT === false) {
    $ROOT = __DIR__;
}

$MIME = array(
    'html' => 'text/html; charset=utf-8',
    'htm'  => 'text/html; charset=utf-8',
    'js'   => 'text/javascript; charset=utf-8',
    'mjs'  => 'text/javascript; charset=utf-8',
    'json' => 'application/json; charset=utf-8',
    'css'  => 'text/css; charset=utf-8',
    'txt'  => 'text/plain; charset=utf-8',
    'wasm' => 'application/wasm',
    'ogg'  => 'audio/ogg',
    'mp3'  => 'audio/mpeg',
    'wav'  => 'audio/wav',
    'ttf'  => 'font/ttf',
    'otf'  => 'font/otf',
    'png'  => 'image/png',
    'jpg'  => 'image/jpeg',
    'jpeg' => 'image/jpeg',
    'gif'  => 'image/gif',
    'svg'  => 'image/svg+xml',
    'webp' => 'image/webp',
    'ico'  => 'image/x-icon',
    'zip'  => 'application/zip',
    'yml'  => 'text/yaml; charset=utf-8',
    'yaml' => 'text/yaml; charset=utf-8',
);

/** 清空所有输出缓冲，保证大文件（wasm 约 9MB）流式输出时不被内存缓冲吃掉。 */
function drop_buffers()
{
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
}

function mime_of($full, $MIME)
{
    $ext = strtolower(pathinfo($full, PATHINFO_EXTENSION));
    return isset($MIME[$ext]) ? $MIME[$ext] : 'application/octet-stream';
}

/** 把磁盘文件的原始字节发出去。$contentType 为 null 时按扩展名推断。 */
function send_file($full, $contentType, $headOnly)
{
    $size = @filesize($full);
    if ($size === false) {
        http_response_code(500);
        return;
    }

    http_response_code(200);
    header('Content-Type: ' . $contentType);
    header('Content-Length: ' . $size);
    header('Content-Disposition: inline');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');

    if ($headOnly) {
        return;
    }

    drop_buffers();
    $fp = @fopen($full, 'rb');
    if ($fp === false) {
        return;
    }
    while (!feof($fp)) {
        $chunk = fread($fp, 262144);
        if ($chunk === false) {
            break;
        }
        echo $chunk;
        flush();
    }
    fclose($fp);
}

/** 把相对路径解析为根目录下的真实文件，越界或不存在时返回 null。 */
function resolve($ROOT, $relative)
{
    $relative = ltrim(str_replace('\\', '/', $relative), '/');
    if ($relative === '') {
        return null;
    }
    $full = realpath($ROOT . DIRECTORY_SEPARATOR . $relative);
    if ($full === false || !is_file($full)) {
        return null;
    }
    if ($full !== $ROOT && strpos($full, $ROOT . DIRECTORY_SEPARATOR) !== 0) {
        return null;
    }
    return $full;
}

function send_plain($code, $text)
{
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    header('Content-Length: ' . strlen($text));
    echo $text;
}

/**
 * /__res?p=<相对路径>
 *
 * 无扩展名出口：URL 上没有 .ogg/.wasm 之类后缀，Content-Type 固定为
 * text/plain，IDM 等工具就不会把它识别成可下载文件；浏览器通过 fetch
 * 拿到的仍是原始字节。
 */
function serve_res($ROOT, $headOnly)
{
    $rel = isset($_GET['p']) ? rawurldecode((string)$_GET['p']) : '';
    $full = resolve($ROOT, $rel);
    if ($full === null) {
        send_plain(404, 'not found');
        return;
    }
    send_file($full, 'text/plain', $headOnly);
}

/**
 * /__proxy?url=<完整 http(s) 地址>
 *
 * 同源代理：转发前端的跨域请求，解决浏览器 CORS 限制。
 */
function serve_proxy($headOnly)
{
    $target = isset($_GET['url']) ? (string)$_GET['url'] : '';
    if (!preg_match('#^https?://#i', $target)) {
        send_plain(400, 'invalid proxy url');
        return;
    }

    $method = isset($_SERVER['REQUEST_METHOD']) ? strtoupper((string)$_SERVER['REQUEST_METHOD']) : 'GET';
    if ($headOnly) {
        $method = 'HEAD';
    }

    $body = null;
    if ($method === 'POST' || $method === 'PUT' || $method === 'PATCH' || $method === 'DELETE') {
        $body = @file_get_contents('php://input');
        if ($body === false) {
            $body = null;
        }
    }

    // 需要原样带给上游的请求头。客户端依赖 If-Modified-Since 判断用户协议是否更新。
    $pass = array('Authorization', 'Accept', 'Accept-Language', 'Content-Type', 'X-Requested-With', 'If-Modified-Since', 'If-None-Match');
    $headers = array();
    foreach ($pass as $name) {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        if ($name === 'Content-Type') {
            $key = 'CONTENT_TYPE';
        }
        if (isset($_SERVER[$key]) && $_SERVER[$key] !== '') {
            $headers[] = $name . ': ' . $_SERVER[$key];
        }
    }
    // 不做压缩转发，避免上游与浏览器重复解压。
    $headers[] = 'Accept-Encoding: identity';
    $headers[] = 'User-Agent: PhiraWeb/1.0';

    // 逐跳（hop-by-hop）响应头不能转发，否则会破坏 HTTP 连接语义。
    //   - `status`：PHP 的 header() 会把它当成状态行，覆盖我们已设好的状态码；
    //   - `location`：重定向已由本代理在服务端跟随，再转发会让浏览器二次跳转；
    //   - `server` / `date`：PHP 自己也会发，重复转发会出现两套值；
    //   - `strict-transport-security` / `alt-svc`：属于上游域名的策略，不该由代理域名继承。
    $skip = array(
        'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
        'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-encoding', 'status',
        'location', 'server', 'date',
        'strict-transport-security', 'alt-svc',
    );

    if (function_exists('curl_init')) {
        proxy_via_curl($target, $method, $headers, $body, $skip);
        return;
    }
    proxy_via_stream($target, $method, $headers, $body, $skip);
}

function proxy_via_curl($target, $method, array $headers, $body, array $skip)
{
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $target);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_MAXREDIRS, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 60);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 15);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
    if ($method === 'HEAD') {
        curl_setopt($ch, CURLOPT_NOBODY, true);
    } elseif ($body !== null && $body !== '') {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }

    // 先把当前这一轮的头收进 $pending，遇到新的状态行就清空重来
    // （说明上一轮已结束）；直到 body 的第一块数据到达（或请求结束）时，
    // 才把「最后一轮」的头连同状态码一次性发出去。这样只会转发真正带
    // body 的那次响应。
    $status = 200;
    $pending = array();
    $sent = false;

    $flushHeaders = function () use (&$status, &$pending, &$sent) {
        drop_buffers();
        if (!headers_sent()) {
            http_response_code($status);
            if (empty($pending)) {
                header('Content-Type: application/octet-stream');
            }
            foreach ($pending as $h) {
                header($h, false);
            }
        }
        $sent = true;
    };

    curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $line) use (&$status, &$pending, $skip) {
        $trim = rtrim($line, "\r\n");
        if ($trim === '') {
            return strlen($line);
        }
        if (stripos($trim, 'HTTP/') === 0) {
            $pending = array();
            $parts = explode(' ', $trim, 3);
            $status = isset($parts[1]) ? (int)$parts[1] : 200;
            return strlen($line);
        }
        $pos = strpos($trim, ':');
        if ($pos !== false) {
            $name = strtolower(trim(substr($trim, 0, $pos)));
            if (!in_array($name, $skip, true)) {
                $pending[] = $trim;
            }
        }
        return strlen($line);
    });
    curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$sent, $flushHeaders) {
        if (!$sent) {
            $flushHeaders();
        }
        echo $chunk;
        return strlen($chunk);
    });

    $ok = curl_exec($ch);
    if ($ok === false) {
        $err = curl_error($ch);
        curl_close($ch);
        if (!$sent) {
            send_plain(502, 'proxy error: ' . $err);
        }
        return;
    }

    // 没有 body 的响应（HEAD / 204 / 304）不会触发 WRITEFUNCTION，
    // 这里补发一次，保证客户端总能拿到正确的状态码与响应头。
    if (!$sent) {
        $flushHeaders();
    }
    curl_close($ch);
}

/** curl 不可用时的退化实现（stream wrapper）。 */
function proxy_via_stream($target, $method, array $headers, $body, array $skip)
{
    $opts = array(
        'method' => $method,
        'header' => implode("\r\n", $headers),
        'ignore_errors' => true,
        'follow_location' => 1,
        'max_redirects' => 5,
        'timeout' => 60,
        'protocol_version' => 1.1,
    );
    if ($body !== null && $body !== '') {
        $opts['content'] = $body;
    }
    $ctx = stream_context_create(array(
        'http' => $opts,
        'ssl' => array('verify_peer' => true, 'verify_peer_name' => true),
    ));

    $fp = @fopen($target, 'rb', false, $ctx);
    if ($fp === false) {
        send_plain(502, 'proxy error: unable to connect');
        return;
    }

    $meta = stream_get_meta_data($fp);
    $lines = isset($meta['wrapper_data']) && is_array($meta['wrapper_data']) ? $meta['wrapper_data'] : array();

    // 与 curl 版同理：跟随重定向时 wrapper_data 里含每一轮的响应头，
    // 只保留「最后一个状态行之后」的那组，避免转发 3xx 中间响应的头
    // （其中带 location 与 content-length: 0，会让浏览器判定网络错误）。
    $status = 200;
    $pending = array();
    foreach ($lines as $line) {
        $trim = rtrim($line, "\r\n");
        if ($trim === '') {
            continue;
        }
        if (stripos($trim, 'HTTP/') === 0) {
            $pending = array();
            $parts = explode(' ', $trim, 3);
            if (isset($parts[1])) {
                $status = (int)$parts[1];
            }
            continue;
        }
        $pos = strpos($trim, ':');
        if ($pos !== false) {
            $name = strtolower(trim(substr($trim, 0, $pos)));
            if (!in_array($name, $skip, true)) {
                $pending[] = $trim;
            }
        }
    }

    drop_buffers();
    if (!headers_sent()) {
        http_response_code($status);
        if (empty($pending)) {
            header('Content-Type: application/octet-stream');
        }
        foreach ($pending as $h) {
            header($h, false);
        }
    }
    while (!feof($fp)) {
        $chunk = fread($fp, 262144);
        if ($chunk === false) {
            break;
        }
        echo $chunk;
        flush();
    }
    fclose($fp);
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

$headOnly = isset($_SERVER['REQUEST_METHOD']) && strtoupper((string)$_SERVER['REQUEST_METHOD']) === 'HEAD';
$path = (string)parse_url(isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/', PHP_URL_PATH);

$isEntryPhp = basename($path) === 'index.php';

if ($path === '/__res' || ($isEntryPhp && isset($_GET['p']) && !isset($_GET['url']))) {
    serve_res($ROOT, $headOnly);
    return;
}

if ($path === '/__proxy' || ($isEntryPhp && isset($_GET['url']))) {
    serve_proxy($headOnly);
    return;
}

if (!in_array(strtoupper((string)(isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET')), array('GET', 'HEAD'), true)) {
    send_plain(405, 'method not allowed');
    return;
}

// 静态文件：/ 映射到 index.html（Phira Web 是纯前端单页，无路由）。
$rel = rawurldecode($path);
if ($rel === '/' || $rel === '') {
    $rel = 'index.html';
} elseif (substr($rel, -1) === '/') {
    $rel .= 'index.html';
}


if (preg_match('/\.php$/i', $rel)) {
    send_plain(404, 'not found');
    return;
}

$full = resolve($ROOT, $rel);
if ($full === null) {
    send_plain(404, 'not found');
    return;
}

send_file($full, mime_of($full, $MIME), $headOnly);
