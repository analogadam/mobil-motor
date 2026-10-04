# MobilMotor simgesini (çok boyutlu .ico) çizer. Windows PowerShell 5.1 ile çalıştır.
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot 'mobilmotor.ico'
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = @()

function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $s / 32.0
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 23, 24, 27))
  $g.FillPath($bg, (RoundRect (1*$k) (1*$k) (30*$k) (30*$k) (7*$k)))
  $orange = [System.Drawing.Color]::FromArgb(255, 255, 106, 43)
  $pen = New-Object System.Drawing.Pen $orange, ([Math]::Max(1.2, 2.2*$k))
  $g.DrawPath($pen, (RoundRect (10*$k) (6*$k) (12*$k) (20*$k) (2.8*$k)))
  $ob = New-Object System.Drawing.SolidBrush $orange
  $dot = [Math]::Max(1.5, 2.8*$k)
  $g.FillEllipse($ob, (16*$k - $dot/2), (21.8*$k - $dot/2), $dot, $dot)
  $green = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 61, 220, 132))
  $gd = 7*$k
  $g.FillEllipse($green, (25*$k - $gd/2), (7*$k - $gd/2), $gd, $gd)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  if ($s -ge 128) {
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  } else {
    # Küçük boyutlar klasik DIB: BITMAPINFOHEADER + 32bpp BGRA (alttan üste) + AND maskesi
    $w = New-Object System.IO.BinaryWriter $ms
    $w.Write([UInt32]40); $w.Write([Int32]$s); $w.Write([Int32]($s * 2))
    $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]0)
    $maskStride = [int]([Math]::Ceiling($s / 32.0) * 4)
    $w.Write([UInt32]($s * $s * 4 + $maskStride * $s))
    $w.Write([Int32]0); $w.Write([Int32]0); $w.Write([UInt32]0); $w.Write([UInt32]0)
    for ($yy = $s - 1; $yy -ge 0; $yy--) {
      for ($xx = 0; $xx -lt $s; $xx++) {
        $c = $bmp.GetPixel($xx, $yy)
        $w.Write([byte]$c.B); $w.Write([byte]$c.G); $w.Write([byte]$c.R); $w.Write([byte]$c.A)
      }
    }
    $w.Write((New-Object byte[] ($maskStride * $s)))
    $w.Flush()
  }
  $pngs += ,@($s, $ms.ToArray())
  $bmp.Dispose()
}

# ICO dosyası: başlık + dizin + PNG verileri
$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($p in $pngs) {
  $s = $p[0]; $data = $p[1]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($p in $pngs) { $bw.Write([byte[]]$p[1]) }
$bw.Close()
"Simge yazıldı: $out"
