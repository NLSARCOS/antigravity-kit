from PIL import Image, ImageDraw

SIZE = 512

def create_public_icon():
    # Start with fully transparent canvas
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    
    # Create the rounded-rect shape mask (macOS squircle)
    mask = Image.new('L', (SIZE, SIZE), 0)
    mask_draw = ImageDraw.Draw(mask)
    radius = int(SIZE * 0.225)
    mask_draw.rounded_rectangle((0, 0, SIZE, SIZE), radius, fill=255)
    
    # Create gradient background
    bg = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg)
    
    # Deep blue-purple gradient: #1a1a3e → #6b21a8 → #2563eb
    for y in range(SIZE):
        for x in range(SIZE):
            # Diagonal gradient
            t = (x / SIZE * 0.5 + y / SIZE * 0.5)
            
            if t < 0.5:
                # Dark navy to purple
                s = t * 2
                r = int(20 + (107 - 20) * s)
                g = int(15 + (33 - 15) * s) 
                b = int(60 + (168 - 60) * s)
            else:
                s = (t - 0.5) * 2
                r = int(107 + (37 - 107) * s)
                g = int(33 + (99 - 33) * s)
                b = int(168 + (235 - 168) * s)
            
            bg_draw.point((x, y), fill=(r, g, b, 255))
    
    # Apply mask to gradient
    bg.putalpha(mask)
    img = Image.alpha_composite(img, bg)
    
    # Draw envelope icon
    envelope_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    env_draw = ImageDraw.Draw(envelope_layer)
    
    env_margin = int(SIZE * 0.25)
    env_top = int(SIZE * 0.35)
    env_bottom = int(SIZE * 0.72)
    env_radius = int(SIZE * 0.04)
    
    env_draw.rounded_rectangle(
        (env_margin, env_top, SIZE - env_margin, env_bottom),
        env_radius,
        fill=(255, 255, 255, 60),
        outline=(255, 255, 255, 100),
        width=2
    )
    
    flap_points = [
        (env_margin, env_top),
        (SIZE // 2, int(SIZE * 0.53)),
        (SIZE - env_margin, env_top),
    ]
    env_draw.line(flap_points, fill=(255, 255, 255, 120), width=2)
    
    plane_cx = int(SIZE * 0.62)
    plane_cy = int(SIZE * 0.32)
    plane_size = int(SIZE * 0.18)
    
    plane_points = [
        (plane_cx - plane_size // 2, plane_cy + plane_size // 2),
        (plane_cx + plane_size // 2, plane_cy - plane_size // 3),
        (plane_cx - plane_size // 4, plane_cy),
    ]
    env_draw.polygon(plane_points, fill=(255, 255, 255, 150))
    
    env_draw.line(
        [(plane_cx - plane_size // 2, plane_cy + plane_size // 2),
         (plane_cx - plane_size, plane_cy + plane_size // 3)],
        fill=(255, 255, 255, 80),
        width=1
    )
    
    # Apply envelope layer with mask
    envelope_layer.putalpha(Image.composite(
        envelope_layer.getchannel('A'),
        Image.new('L', (SIZE, SIZE), 0),
        mask
    ))
    
    img = Image.alpha_composite(img, envelope_layer)
    
    # Save to public directory
    img.save('public/icon.png', 'PNG')
    print(f"Created public/icon.png ({SIZE}x{SIZE}) with true transparency for the onboarding screen.")

if __name__ == '__main__':
    create_public_icon()
