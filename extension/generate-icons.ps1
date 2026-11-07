Add-Type -AssemblyName System.Drawing

$sizes = @(16, 32, 48, 128, 300)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $scriptDir "icons"

if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Background rounded rect
    $padding = [Math]::Max(1.0, $size * 0.04)
    $bgRect = New-Object System.Drawing.RectangleF $padding, $padding, ($size - 2 * $padding), ($size - 2 * $padding)
    
    # Linear Gradient from deep indigo to purple
    $cTop = [System.Drawing.Color]::FromArgb(255, 30, 27, 75)       # #1e1b4b
    $cBottom = [System.Drawing.Color]::FromArgb(255, 15, 12, 35)    # #0f0c23
    $brushBg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $bgRect, $cTop, $cBottom, 45.0
    
    # Rounded rectangle background
    $radius = $size * 0.22
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $x = $bgRect.X
    $y = $bgRect.Y
    $w = $bgRect.Width
    $h = $bgRect.Height
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    
    $g.FillPath($brushBg, $path)

    # Subtle violet glow border
    $penBorder = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(180, 99, 102, 241)), ([Math]::Max(1.0, $size * 0.04))
    $g.DrawPath($penBorder, $path)

    # Scaled Lightning Bolt in center
    $polyPoints = @(
        (New-Object System.Drawing.PointF ($size * 0.53), ($size * 0.16)),
        (New-Object System.Drawing.PointF ($size * 0.26), ($size * 0.53)),
        (New-Object System.Drawing.PointF ($size * 0.48), ($size * 0.53)),
        (New-Object System.Drawing.PointF ($size * 0.43), ($size * 0.84)),
        (New-Object System.Drawing.PointF ($size * 0.74), ($size * 0.47)),
        (New-Object System.Drawing.PointF ($size * 0.52), ($size * 0.47))
    )

    $boltPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $boltPath.AddPolygon($polyPoints)

    # Electric gradient for the bolt (gold/amber)
    $cBolt1 = [System.Drawing.Color]::FromArgb(255, 255, 225, 75)   # bright gold
    $cBolt2 = [System.Drawing.Color]::FromArgb(255, 245, 158, 11)   # amber
    $boltRect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
    $brushBolt = New-Object System.Drawing.Drawing2D.LinearGradientBrush $boltRect, $cBolt1, $cBolt2, 60.0
    
    $g.FillPath($brushBolt, $boltPath)

    # Fast-forward chevron on right side for skipping indicator
    if ($size -ge 32) {
        $penChev = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(230, 165, 180, 252)), ([Math]::Max(1.5, $size * 0.05))
        $penChev.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $penChev.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $penChev.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        
        $c1x = $size * 0.79
        $c1yTop = $size * 0.38
        $c1yMid = $size * 0.50
        $c1yBot = $size * 0.62
        $g.DrawLine($penChev, ($c1x - $size * 0.06), $c1yTop, $c1x, $c1yMid)
        $g.DrawLine($penChev, $c1x, $c1yMid, ($c1x - $size * 0.06), $c1yBot)
        $penChev.Dispose()
    }

    $filePath = Join-Path $outDir "icon-$size.png"
    $bmp.Save($filePath, [System.Drawing.Imaging.ImageFormat]::Png)

    $brushBolt.Dispose()
    $boltPath.Dispose()
    $penBorder.Dispose()
    $brushBg.Dispose()
    $path.Dispose()
    $g.Dispose()
    $bmp.Dispose()
}

Write-Output "Successfully generated icons: 16, 32, 48, 128, 300 in $outDir"
