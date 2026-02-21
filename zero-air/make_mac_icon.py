"""
Build Simplex Mail icon as a FULL SCALE RGB SQUARE.
Strictly NO alpha channel for the target app icon.
"""
from PIL import Image, ImageDraw

SIZE = 1024

def create_mac_icon():
    # Full opaque square RGB mode
    img = Image.new('RGB', (SIZE, SIZE), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Draw gradient background filling the ENTIRE square
    for y in range(SIZE):
        for x in range(SIZE):
            t = (x / SIZE * 0.5 + y / SIZE * 0.5)
            if t < 0.5:
                s = t * 2
                r = int(20 + (107 - 20) * s)
                g = int(15 + (33 - 15) * s) 
                b = int(60 + (168 - 60) * s)
            else:
                s = (t - 0.5) * 2
                r = int(107 + (37 - 107) * s)
                g = int(33 + (99 - 33) * s)
                b = int(168 + (235 - 168) * s)
            draw.point((x, y), fill=(r, g, b))
    
    # Draw envelope icon - use an RGBA temporary layer
    overlay = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    env_draw = ImageDraw.Draw(overlay)
    
    env_margin = int(SIZE * 0.25)
    env_top = int(SIZE * 0.35)
    env_bottom = int(SIZE * 0.72)
    env_radius = int(SIZE * 0.04)
    
    env_draw.rounded_rectangle(
        (env_margin, env_top, SIZE - env_margin, env_bottom),
        env_radius,
        fill=(255, 255, 255, 60),
        outline=(255, 255, 255, 100),
        width=3
    )
    
    flap_points = [
        (env_margin, env_top),
        (SIZE // 2, int(SIZE * 0.53)),
        (SIZE - env_margin, env_top),
    ]
    env_draw.line(flap_points, fill=(255, 255, 255, 120), width=3)
    
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
        width=2
    )
    
    # Composite overlay onto RGB background
    img.paste(overlay, (0, 0), overlay)
    
    # Save as full square RGB PNG
    img.save('app-icon.png', 'PNG')
    print(f"Created FULL SQUARE RGB app-icon.png ({SIZE}x{SIZE})")

if __name__ == '__main__':
    create_mac_icon()
