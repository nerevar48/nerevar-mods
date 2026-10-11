# Сканер, миниатюры и просмотр для мода image-library.
#   -Mode scan    : JSON-массив найденных изображений из корней, переданных в stdin
#                   ([{ source, session, path, skipBuildDirs }]), в stdout.
#   -Mode thumbs  : JSON-массив путей в stdin; для каждого создаёт JPEG-миниатюру
#                   в -CacheDir (если её ещё нет) и печатает { path: thumbPath|null }.
#   -Mode preview : JSON-строка пути в stdin; уменьшает картинку до ширины -Size и режет
#                   на JPEG-полосы не больше -StripBytes каждая (столько вмещает одна Svg).
#                   Печатает { width, height, strips: [{ path, height }] } или null.
#   -Mode copy    : JSON-строка в stdin кладётся в буфер обмена.
param(
  [Parameter(Mandatory)] [ValidateSet('scan', 'thumbs', 'preview', 'copy')] [string] $Mode,
  [string] $CacheDir,
  [int] $Size = 192,
  [int] $Limit = 3000,
  [int] $StripBytes = 95000
)

$ErrorActionPreference = 'Stop'
# Node пишет и читает UTF-8; без этого кириллица в путях декодируется как OEM-кодировка.
# Без привязанной консоли присваивание может бросить «The handle is invalid»: тогда остаётся как есть.
try {
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
} catch {}
$inputText = [Console]::In.ReadToEnd()
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

# Копия картинки, вписанная в $maxWidth × $maxHeight (не больше исходника), на белом фоне.
function New-Scaled([Drawing.Image] $image, [double] $maxWidth, [double] $maxHeight) {
  $scale = [Math]::Min(1.0, [Math]::Min($maxWidth / $image.Width, $maxHeight / $image.Height))
  $bitmap = [Drawing.Bitmap]::new([Math]::Max(1, [int]($image.Width * $scale)), [Math]::Max(1, [int]($image.Height * $scale)))
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([Drawing.Color]::White)
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($image, 0, 0, $bitmap.Width, $bitmap.Height)
  } finally { $graphics.Dispose() }
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
  $name = Get-CacheName $info "preview$Size|$StripBytes"
  $manifest = Join-Path $CacheDir "$name.json"
  if ([IO.File]::Exists($manifest)) {
    [IO.File]::ReadAllText($manifest)
    exit 0
  }

  $image = [Drawing.Image]::FromFile($info.FullName)
  try {
    $scaled = New-Scaled $image $Size ([double]::MaxValue)
    try {
      $strips = [Collections.Generic.List[object]]::new()
      $stripHeight = 320
      for ($top = 0; $top -lt $scaled.Height; $top += $stripHeight) {
        $height = [Math]::Min($stripHeight, $scaled.Height - $top)
        $strip = $scaled.Clone([Drawing.Rectangle]::new(0, $top, $scaled.Width, $height), $scaled.PixelFormat)
        try {
          # Качество снижается, пока полоса не уложится в лимит одной Svg.
          $quality = 85
          $bytes = Get-JpegBytes $strip $quality
          while ($bytes.Length -gt $StripBytes -and $quality -gt 25) {
            $quality -= 15
            $bytes = Get-JpegBytes $strip $quality
          }
        } finally { $strip.Dispose() }
        if ($bytes.Length -gt $StripBytes) { throw "полоса $top не уложилась в $StripBytes байт" }
        $stripPath = Join-Path $CacheDir "$name-$($strips.Count).jpg"
        [IO.File]::WriteAllBytes($stripPath, $bytes)
        $strips.Add([pscustomobject]@{ path = $stripPath; height = $height })
      }
      $json = ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{
          width  = $scaled.Width
          height = $scaled.Height
          strips = $strips.ToArray()
        })
    } finally { $scaled.Dispose() }
  } finally { $image.Dispose() }
  [IO.File]::WriteAllText($manifest, $json)
  $json
} finally { $md5.Dispose() }
