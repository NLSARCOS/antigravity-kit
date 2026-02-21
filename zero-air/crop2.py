from PIL import Image, ImageDraw

def process_png(path):
    # Open the generated image
    img = Image.open(path).convert('RGBA')
    
    # Create a new transparent image matching size
    out = Image.new('RGBA', img.size, (0,0,0,0))
    
    # We want to replace the white background with transparency.
    # But since it's an app icon, let's keep it simple: 
    # Just grab the existing transparent image we had before, 
    # and ensure the corners are actually transparent!
    
    w, h = img.size
    
    # Create squircle mask
    mask = Image.new('L', (w, h), 0)
    draw = ImageDraw.Draw(mask)
    
    # macOS squircle radius is about 22.5% of the icon width
    r = int(w * 0.225)
    draw.rounded_rectangle((0, 0, w, h), r, fill=255)
    
    # Paste using mask
    out.paste(img, (0, 0), mask)
    
    # Save properly
    out.save("app-icon.png", "PNG")

if __name__ == "__main__":
    import sys
    process_png(sys.argv[1])
