from PIL import Image, ImageDraw

def refine_icon(path):
    img = Image.open(path).convert('RGBA')
    w, h = img.size
    
    # The AI drew a white border inside the image. Let's crop the center nicely.
    # We will crop from 12% to 88% to get rid of the white frame.
    crop_margin_x = int(w * 0.12)
    crop_margin_y = int(h * 0.12)
    
    cropped = img.crop((crop_margin_x, crop_margin_y, w - crop_margin_x, h - crop_margin_y))
    
    # Now we have the tight gradient square. Let's resize back to 1024x1024.
    resized = cropped.resize((1024, 1024), Image.Resampling.LANCZOS)
    
    # Apply perfect transparent squircle matching Apple's specs
    mask = Image.new('L', (1024, 1024), 0)
    draw = ImageDraw.Draw(mask)
    
    # macOS radius is exactly 22.5% of the size
    r = int(1024 * 0.225)
    draw.rounded_rectangle((0, 0, 1024, 1024), r, fill=255)
    
    out = Image.new('RGBA', (1024, 1024), (0,0,0,0))
    out.paste(resized, (0, 0), mask)
    
    out.save("app-icon.png", "PNG")

if __name__ == "__main__":
    import sys
    refine_icon(sys.argv[1])
