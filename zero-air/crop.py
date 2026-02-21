from PIL import Image, ImageDraw

def mask_squircle(img_path, out_path, border_radius_ratio=0.225):
    # Open the image
    img = Image.open(img_path).convert("RGBA")
    w, h = img.size
    
    # Create mask
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    
    # Calculate radius based on the image size
    radius = int(min(w, h) * border_radius_ratio)
    
    # Draw rounded rectangle
    draw.rounded_rectangle((0, 0, w, h), radius, fill=255)
    
    # Apply the mask to the alpha channel
    img.putalpha(mask)
    
    # Resize to exactly 1024x1024 for Tauri
    img = img.resize((1024, 1024), Image.Resampling.LANCZOS)
    
    # Save as PNG
    img.save(out_path, "PNG")

if __name__ == "__main__":
    import sys
    mask_squircle(sys.argv[1], sys.argv[2])
