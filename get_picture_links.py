import re
import os

with open("raah.html", "r", encoding="utf-8") as file:
    data = file.read()

# Grab the direct CDN links (not the wiki description pages, which 403 wget)
regex = r'href="(https://static\.wikia\.nocookie\.net/[^"]+?_Hero\.png/revision/latest\?cb=\d+)"'
links = re.findall(regex, data)
print(f"Found {len(links)} picture links.")

os.makedirs("images", exist_ok=True)

for link in links:
    filename = re.search(r'/([^/]+_Hero\.png)/revision', link).group(1)
    output_path = os.path.join("images", filename)
    print(f"Downloading {filename}...")
    download_command = f'.\\wget "{link}" -O "{output_path}" --user-agent="Mozilla/5.0"'
    os.system(download_command)