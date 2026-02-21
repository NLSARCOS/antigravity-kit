from PIL import Image, ImageDraw

def process_perfect_crop(path):
    img = Image.open(path).convert('RGBA')
    
    # We found the AI gradient is from 164 to 859.
    # By cropping slightly inwards to (180, 180, 844, 844),
    # we discard the white border and the white rounded corners.
    cropped = img.crop((180, 180, 844, 844))
    
    # Resize back up to 1024x1024 for macOS standard
    resized = cropped.resize((1024, 1024), Image.Resampling.LANCZOS)
    
    # Mask with perfect squircle
    mask = Image.new('L', (1024, 1024), 0)
    draw = ImageDraw.Draw(mask)
    r = int(1024 * 0.225) # macOS standard radius rating
    draw.rounded_rectangle((0, 0, 1024, 1024), r, fill=255)
    
    out = Image.new('RGBA', (1024, 1024), (0,0,0,0))
    out.paste(resized, (0, 0), mask)
    
    out.save("app-icon.png", "PNG")

if __name__ == "__main__":
    import sys
    process_perfect_crop(sys.argv[1])
