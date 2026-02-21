from PIL import Image

path = "/Users/nelsonsarcos/.gemini/antigravity/brain/c1860f65-f3e7-4b8f-9aa9-2c5045582e57/simplex_mail_icon_no_text_1771697675035.png"
img = Image.open(path).convert('RGBA')
w, h = img.size
pixels = img.load()

cy = h // 2
cx = w // 2

left = 0
for x in range(cx):
    r, g, b, a = pixels[x, cy]
    if r < 240 or g < 240 or b < 240:
        left = x
        break

right = w - 1
for x in range(w - 1, cx, -1):
    r, g, b, a = pixels[x, cy]
    if r < 240 or g < 240 or b < 240:
        right = x
        break

top = 0
for y in range(cy):
    r, g, b, a = pixels[cx, y]
    if r < 240 or g < 240 or b < 240:
        top = y
        break

bottom = h - 1
for y in range(h - 1, cy, -1):
    r, g, b, a = pixels[cx, y]
    if r < 240 or g < 240 or b < 240:
        bottom = y
        break

print(f"Image Size: {w}x{h}")
print(f"Gradient edges (center cross-section): left={left}, right={right}, top={top}, bottom={bottom}")
