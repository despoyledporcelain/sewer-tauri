# Reproducible, local artwork. No downloaded stock images or build dependency.
# Double-resolution bitmaps are scaled by NSIS for high-DPI displays.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$destination = Join-Path $PSScriptRoot '..\src-tauri\installer'

function Color([int]$r, [int]$g, [int]$b, [int]$alpha = 255) {
  [System.Drawing.Color]::FromArgb($alpha, $r, $g, $b)
}

function Text($g, [string]$text, [float]$x, [float]$y, [float]$size, $color, $weight = [System.Drawing.FontStyle]::Regular) {
  $font = [System.Drawing.Font]::new('Segoe UI', $size, $weight, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = [System.Drawing.SolidBrush]::new($color)
  try { $g.DrawString($text, $font, $brush, $x, $y) }
  finally { $font.Dispose(); $brush.Dispose() }
}

function Record($g, [float]$cx, [float]$cy, [float]$radius) {
  $disc = [System.Drawing.SolidBrush]::new((Color 19 19 27))
  $g.FillEllipse($disc, $cx - $radius, $cy - $radius, 2 * $radius, 2 * $radius)
  $disc.Dispose()
  # Closely spaced grooves, not a generic gradient-orb illustration.
  for ($r = $radius - 2; $r -gt $radius * 0.28; $r -= 3.2) {
    $pen = [System.Drawing.Pen]::new((Color 91 91 111 54), 0.7)
    $g.DrawEllipse($pen, $cx - $r, $cy - $r, 2 * $r, 2 * $r)
    $pen.Dispose()
  }
  $highlight = [System.Drawing.Pen]::new((Color 185 185 209 90), 1.0)
  $g.DrawArc($highlight, $cx - $radius + 2, $cy - $radius + 2, 2 * $radius - 4, 2 * $radius - 4, 205, 55)
  $highlight.Dispose()
  $labelRadius = $radius * 0.25
  $label = [System.Drawing.SolidBrush]::new((Color 178 178 188))
  $g.FillEllipse($label, $cx - $labelRadius, $cy - $labelRadius, 2 * $labelRadius, 2 * $labelRadius)
  $label.Dispose()
  $hole = [System.Drawing.SolidBrush]::new((Color 13 13 19))
  $g.FillEllipse($hole, $cx - 2.5, $cy - 2.5, 5, 5)
  $hole.Dispose()
}

function Render([string]$file, [int]$width, [int]$height, [scriptblock]$draw) {
  $bitmap = [System.Drawing.Bitmap]::new($width * 2, $height * 2, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.ScaleTransform(2, 2)
  $g.Clear((Color 13 13 19))
  try {
    & $draw $g
    $bitmap.Save((Join-Path $destination $file), [System.Drawing.Imaging.ImageFormat]::Bmp)
  } finally { $g.Dispose(); $bitmap.Dispose() }
}

Render 'sidebar.bmp' 164 314 {
  param($g)
  Text $g 'seWer' 21 22 22 (Color 240 240 244) ([System.Drawing.FontStyle]::Bold)
  Text $g 'music feels personal.' 22 54 8.5 (Color 160 160 174)
  Record $g 58 177 106
  # A miniature playback line grounds the artwork in the player's vocabulary.
  $track = [System.Drawing.Pen]::new((Color 47 47 61), 1.5)
  $played = [System.Drawing.Pen]::new((Color 178 178 188), 1.5)
  $g.DrawLine($track, 23, 272, 140, 272)
  $g.DrawLine($played, 23, 272, 66, 272)
  $track.Dispose(); $played.Dispose()
  Text $g 'soundcloud + local' 22 283 8.5 (Color 160 160 174)
}

Render 'header.bmp' 150 57 {
  param($g)
  Record $g 125 28.5 25
  Text $g 'seWer' 10 16 20 (Color 240 240 244) ([System.Drawing.FontStyle]::Bold)
}
Write-Output 'installer artwork: sidebar.bmp, header.bmp'
