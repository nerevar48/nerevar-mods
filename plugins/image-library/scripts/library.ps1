# Сканер и генератор миниатюр для мода image-library.
#   -Mode scan   : JSON-массив найденных изображений из корней, переданных в stdin
#                  ([{ source, session?, path }]), в stdout.
#   -Mode thumbs : JSON-массив путей в stdin; для каждого создаёт JPEG-миниатюру
#                  в -CacheDir (если её ещё нет) и печатает { path: thumbPath|null }.
param(
  [Parameter(Mandatory)] [ValidateSet('scan', 'thumbs')] [string] $Mode,
  [string] $CacheDir,
  [int] $Size = 192,
  [int] $Limit = 3000
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$inputText = [Console]::In.ReadToEnd()
$request = if ($inputText.Trim()) { ConvertFrom-Json $inputText } else { @() }

$extensions = @('.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg')
# Папки сборки, зависимостей и кэшей: в них картинки не создаются руками или агентом.
$skipDirs = @('node_modules', '.git', '.hg', '.svn', 'Library', 'Temp', 'Obj', 'obj', 'Logs',
  'bin', 'dist', 'build', 'Build', 'out', '.next', '.nuxt', '.venv', 'venv', '__pycache__',
  '.gradle', '.idea', '.vs', 'types', 'packages', 'Packages', 'PackageCache')

function Find-Images([string] $root) {
  $stack = [Collections.Generic.Stack[string]]::new()
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    try { $entries = [IO.Directory]::EnumerateFileSystemEntries($dir) } catch { continue }
    foreach ($entry in $entries) {
      $name = [IO.Path]::GetFileName($entry)
      $attributes = [IO.File]::GetAttributes($entry)
      if ($attributes -band [IO.FileAttributes]::Directory) {
        if (-not ($attributes -band [IO.FileAttributes]::ReparsePoint) -and $skipDirs -notcontains $name) {
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
    foreach ($file in Find-Images $root.path) {
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
$quality = [Drawing.Imaging.EncoderParameters]::new(1)
$quality.Param[0] = [Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality, [long]80)
$result = [ordered]@{}

foreach ($path in $request) {
  $result[$path] = $null
  try {
    $info = [IO.FileInfo]::new($path)
    $key = "$($info.FullName)|$($info.LastWriteTimeUtc.Ticks)|$Size"
    $hash = -join ($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($key)) | ForEach-Object { $_.ToString('x2') })
    $thumb = Join-Path $CacheDir "$hash.jpg"
    if (-not [IO.File]::Exists($thumb)) {
      $image = [Drawing.Image]::FromFile($info.FullName)
      try {
        $scale = [Math]::Min(1.0, [Math]::Min($Size / $image.Width, $Size / $image.Height))
        $width = [Math]::Max(1, [int]($image.Width * $scale))
        $height = [Math]::Max(1, [int]($image.Height * $scale))
        $bitmap = [Drawing.Bitmap]::new($width, $height)
        try {
          $graphics = [Drawing.Graphics]::FromImage($bitmap)
          try {
            $graphics.Clear([Drawing.Color]::White)
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($image, 0, 0, $width, $height)
          } finally { $graphics.Dispose() }
          $bitmap.Save($thumb, $jpeg, $quality)
        } finally { $bitmap.Dispose() }
      } finally { $image.Dispose() }
    }
    $result[$path] = $thumb
  } catch {
    # Формат, который System.Drawing не читает (webp, svg), или битый файл: без миниатюры.
  }
}

$md5.Dispose()
ConvertTo-Json -InputObject $result -Compress
