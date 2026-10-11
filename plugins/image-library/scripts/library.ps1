# Сканер, миниатюры и просмотр для мода image-library.
#   -Mode scan    : JSON-массив найденных изображений из корней, переданных в stdin
#                   ([{ source, session, path, skipBuildDirs }]), в stdout.
#   -Mode thumbs  : JSON-массив путей в stdin; для каждого создаёт JPEG-миниатюру
#                   в -CacheDir (если её ещё нет) и печатает { path: thumbPath|null }.
#   -Mode preview : JSON-строка пути в stdin; вписывает картинку в -Size × -MaxHeight и режет
#                   на JPEG-полосы не больше -StripBytes каждая (столько вмещает одна Svg).
#                   Печатает { width, height, strips: [{ path, height }] }, или null, если
#                   формат не читается; прочие сбои — ненулевой код выхода.
#   -Mode copy    : JSON-строка в stdin кладётся в буфер обмена.
param(
  [Parameter(Mandatory)] [ValidateSet('scan', 'thumbs', 'preview', 'copy')] [string] $Mode,
  [string] $CacheDir,
  [int] $Size = 192,
  [int] $Limit = 3000,
  [int] $StripBytes = 95000,
  [int] $MaxHeight = 3200
)

$ErrorActionPreference = 'Stop'
# Node пишет и читает UTF-8; без этого кириллица в путях декодируется как OEM-кодировка.
# Без привязанной консоли присваивание может бросить «The handle is invalid»: тогда остаётся как есть.
try {
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
} catch {}
# BOM в начале ввода (его добавляет запуск из консоли с UTF-8) ConvertFrom-Json не принимает.
$inputText = [Console]::In.ReadToEnd().TrimStart([char] 0xFEFF)
$request = if ($inputText.Trim()) { ConvertFrom-Json $inputText } else { @() }

if ($Mode -eq 'copy') {
  Set-Clipboard -Value ([string] $request)
  exit 0
}

$extensions = @('.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg')
# Папки сборки, зависимостей и кэшей проекта: в них картинки не создаются руками или агентом.
# -contains сравнивает без учёта регистра.
$skipDirs = @('node_modules', '.git', '.hg', '.svn', 'Library', 'Temp', 'Obj', 'Logs', 'bin',
  'dist', 'build', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gradle', '.idea', '.vs',
  'Packages', 'PackageCache')

function Find-Images([string] $root, [bool] $skipBuildDirs) {
  $stack = [Collections.Generic.Stack[string]]::new()
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    try { $entries = [IO.Directory]::EnumerateFileSystemEntries($dir) } catch { continue }
    foreach ($entry in $entries) {
      $name = [IO.Path]::GetFileName($entry)
      $attributes = [IO.File]::GetAttributes($entry)
      if ($attributes -band [IO.FileAttributes]::Directory) {
        $isSkipped = $skipBuildDirs -and $skipDirs -contains $name
        if (-not ($attributes -band [IO.FileAttributes]::ReparsePoint) -and -not $isSkipped) {
          $stack.Push($entry)
        }
      } elseif ($extensions -contains [IO.Path]::GetExtension($name).ToLowerInvariant()) {
        $entry
      }
    }
  }
}

if ($Mode -eq 'scan') {
  $found = foreach ($root in $request) {
    if (-not [IO.Directory]::Exists($root.path)) { continue }
    foreach ($file in Find-Images $root.path ([bool] $root.skipBuildDirs)) {
      $info = [IO.FileInfo]::new($file)
      [pscustomobject]@{
        path    = $info.FullName
        name    = $info.Name
        source  = $root.source
        session = $root.session
        size    = $info.Length
        mtimeMs = [long]($info.LastWriteTimeUtc - [datetime]'1970-01-01').TotalMilliseconds
      }
    }
  }
  $sorted = @($found | Sort-Object mtimeMs -Descending | Select-Object -First $Limit)
  ConvertTo-Json -InputObject $sorted -Compress -Depth 3
  exit 0
}

Add-Type -AssemblyName System.Drawing
[IO.Directory]::CreateDirectory($CacheDir) | Out-Null
$md5 = [Security.Cryptography.MD5]::Create()
$jpeg = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }

function Get-CacheName([IO.FileInfo] $info, [string] $kind) {
  $key = "$($info.FullName)|$($info.LastWriteTimeUtc.Ticks)|$kind"
  -join ($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($key)) | ForEach-Object { $_.ToString('x2') })
}

function Get-JpegBytes([Drawing.Image] $image, [long] $quality) {
  $parameters = [Drawing.Imaging.EncoderParameters]::new(1)
  $parameters.Param[0] = [Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality, $quality)
  $stream = [IO.MemoryStream]::new()
  try {
    $image.Save($stream, $jpeg, $parameters)
    , $stream.ToArray()
  } finally {
    $stream.Dispose()
    $parameters.Dispose()
  }
}

# Запись во временный файл и переименование: параллельный запуск не прочтёт файл недописанным.
# Уже готовый файл (его записал параллельный запуск) не перезаписывается.
function Write-Atomic([string] $path, [scriptblock] $write) {
  $temp = "$path.$PID.tmp"
  & $write $temp
  try { [IO.File]::Move($temp, $path) } catch {
    [IO.File]::Delete($temp)
    # Файл уже записал параллельный запуск — это не сбой; иначе (место, права) — сбой.
    if (-not [IO.File]::Exists($path)) { throw }
  }
}

# Копия картинки, вписанная в $maxWidth × $maxHeight (не больше исходника), на белом фоне.
function New-Scaled([Drawing.Image] $image, [double] $maxWidth, [double] $maxHeight) {
  $scale = [Math]::Min(1.0, [Math]::Min($maxWidth / $image.Width, $maxHeight / $image.Height))
  $bitmap = [Drawing.Bitmap]::new([Math]::Max(1, [int]($image.Width * $scale)), [Math]::Max(1, [int]($image.Height * $scale)))
  try {
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([Drawing.Color]::White)
      $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($image, 0, 0, $bitmap.Width, $bitmap.Height)
    } finally { $graphics.Dispose() }
  } catch {
    $bitmap.Dispose()
    throw
  }
  $bitmap
}

try {
  if ($Mode -eq 'thumbs') {
    $result = [ordered]@{}
    foreach ($path in $request) {
      $result[$path] = $null
      try {
        $info = [IO.FileInfo]::new($path)
        $thumb = Join-Path $CacheDir "$(Get-CacheName $info "thumb$Size").jpg"
        if (-not [IO.File]::Exists($thumb)) {
          $image = [Drawing.Image]::FromFile($info.FullName)
          try {
            $scaled = New-Scaled $image $Size $Size
            try { [IO.File]::WriteAllBytes($thumb, (Get-JpegBytes $scaled 80)) } finally { $scaled.Dispose() }
          } finally { $image.Dispose() }
        }
        $result[$path] = $thumb
      } catch {
        # Формат, который System.Drawing не читает (webp, svg), или битый файл: без миниатюры.
      }
    }
    ConvertTo-Json -InputObject $result -Compress
    exit 0
  }

  # preview
  $info = [IO.FileInfo]::new([string] $request)
  $name = Get-CacheName $info "preview$Size|$MaxHeight|$StripBytes"
  $manifest = Join-Path $CacheDir "$name.json"
  # Манифест годится, пока на диске все его полосы.
  if ([IO.File]::Exists($manifest)) {
    $cached = [IO.File]::ReadAllText($manifest)
    # Испорченный манифест считается негодным и делается заново.
    $isWhole = try { @((ConvertFrom-Json $cached).strips | Where-Object { -not [IO.File]::Exists($_.path) }).Count -eq 0 } catch { $false }
    if ($isWhole) {
      $cached
      exit 0
    }
  }

  # Занятый или пропавший файл — сбой (IOException отсюда), следующая попытка повторит:
  # System.Drawing сообщил бы о нём так же, как о нечитаемом формате.
  [IO.File]::Open($info.FullName, 'Open', 'Read', 'ReadWrite').Dispose()
  try { $image = [Drawing.Image]::FromFile($info.FullName) } catch {
    # Формат, который System.Drawing не читает: просмотра нет, это не сбой.
    'null'
    exit 0
  }
  try {
    # Высокая картинка уменьшается целиком, а не обрезается: не больше $MaxHeight по высоте.
    $scaled = New-Scaled $image $Size $MaxHeight
    try {
      $strips = [Collections.Generic.List[object]]::new()
      $top = 0
      while ($top -lt $scaled.Height) {
        # Качество снижается, пока полоса не уложится в лимит одной Svg; не уложилась — полоса ниже.
        $height = [Math]::Min(320, $scaled.Height - $top)
        while ($true) {
          $strip = $scaled.Clone([Drawing.Rectangle]::new(0, $top, $scaled.Width, $height), $scaled.PixelFormat)
          try {
            $quality = 85
            $bytes = Get-JpegBytes $strip $quality
            while ($bytes.Length -gt $StripBytes -and $quality -gt 25) {
              $quality -= 15
              $bytes = Get-JpegBytes $strip $quality
            }
          } finally { $strip.Dispose() }
          if ($bytes.Length -le $StripBytes -or $height -le 16) { break }
          $height = [Math]::Max(16, [int]($height / 2))
        }
        if ($bytes.Length -gt $StripBytes) { throw "полоса на $top px не уложилась в $StripBytes байт" }
        $stripPath = Join-Path $CacheDir "$name-$($strips.Count).jpg"
        Write-Atomic $stripPath { param($temp) [IO.File]::WriteAllBytes($temp, $bytes) }
        $strips.Add([pscustomobject]@{ path = $stripPath; height = $height })
        $top += $height
      }
      $json = ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{
          width  = $scaled.Width
          height = $scaled.Height
          strips = $strips.ToArray()
        })
    } finally { $scaled.Dispose() }
  } finally { $image.Dispose() }
  Write-Atomic $manifest { param($temp) [IO.File]::WriteAllText($temp, $json) }
  $json
} finally { $md5.Dispose() }
