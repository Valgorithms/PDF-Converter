// The Image to PDF page: collect images, put them in order, and make a PDF with a page for each.
import { imagesToPdf } from './image-to-pdf.js';

const $ = (id) => document.getElementById(id);

/** @type {{id: number, file: File, url: string, width: number, height: number}[]} The pages, in order. */
let pages = [];
let nextId = 1;
let resultUrl = null;
let dragged = null;

function say(message, isError = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', isError);
}

function sizeText(bytes) {
  return bytes < 1048576 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

/** A stale PDF would no longer match the pages, so any change hides it. */
function forgetResult() {
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
  $('result').hidden = true;
}

// ---- Adding and removing

async function add(files) {
  const images = [...files].filter((file) => file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name));
  if (!images.length) {
    return;
  }

  forgetResult();
  const refused = [];

  for (const file of images) {
    try {
      // Only the size is needed now; the pixels are decoded again when the PDF is made, one image at a time.
      const bitmap = await createImageBitmap(file);
      pages.push({ id: nextId++, file, url: URL.createObjectURL(file), width: bitmap.width, height: bitmap.height });
      bitmap.close();
    } catch {
      refused.push(file.name);
    }
  }

  draw();
  say(refused.length
    ? `${refused.join(', ')} ${refused.length === 1 ? 'is not an image' : 'are not images'} this browser can read.`
    : `${images.length === 1 ? '1 image' : `${images.length} images`} added.`, refused.length > 0);
}

function remove(page) {
  URL.revokeObjectURL(page.url);
  pages = pages.filter((other) => other !== page);
  forgetResult();
  draw();
  say(`${page.file.name} removed.`);
}

function move(page, to) {
  const from = pages.indexOf(page);
  if (from < 0 || to < 0 || to >= pages.length || to === from) {
    return;
  }
  pages.splice(from, 1);
  pages.splice(to, 0, page);
  forgetResult();
  draw();
  say(`${page.file.name} is now page ${to + 1}.`);
}

// ---- The list

function draw() {
  const list = $('pages');
  const focused = document.activeElement?.dataset?.control;
  const focusedId = Number(document.activeElement?.closest?.('.page')?.dataset.id);

  list.replaceChildren(...pages.map((page, index) => {
    const item = document.createElement('li');
    item.className = 'page';
    item.draggable = true;
    item.dataset.id = page.id;

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⠿';
    grip.setAttribute('aria-hidden', 'true');

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.src = page.url;
    thumb.alt = '';
    thumb.draggable = false;

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = page.file.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `Page ${index + 1} · ${page.width} × ${page.height} px`;
    info.append(name, meta);

    const controls = document.createElement('div');
    controls.className = 'controls';
    controls.append(
      button('↑', `Move ${page.file.name} up`, 'up', index === 0, () => move(page, index - 1)),
      button('↓', `Move ${page.file.name} down`, 'down', index === pages.length - 1, () => move(page, index + 1)),
      button('×', `Remove ${page.file.name}`, 'remove', false, () => remove(page)),
    );

    item.append(grip, thumb, info, controls);
    item.addEventListener('dragstart', (event) => {
      dragged = page;
      item.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/x-page', String(page.id));
    });
    item.addEventListener('dragend', () => {
      dragged = null;
      item.classList.remove('dragging');
      clearMarkers();
    });
    item.addEventListener('dragover', (event) => {
      if (!dragged) {
        return;
      }
      event.preventDefault();
      clearMarkers();
      item.classList.add(isAfter(event, item) ? 'drop-after' : 'drop-before');
    });
    item.addEventListener('drop', (event) => {
      if (!dragged) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const target = pages.indexOf(page) + (isAfter(event, item) ? 1 : 0);
      const from = pages.indexOf(dragged);
      move(dragged, from < target ? target - 1 : target);
    });
    return item;
  }));

  // Keep the keyboard where it was after a move re-draws the list.
  if (focused && focusedId) {
    const control = list.querySelector(`.page[data-id="${focusedId}"] [data-control="${focused}"]`);
    (control && !control.disabled ? control : list.querySelector(`.page[data-id="${focusedId}"] [data-control="remove"]`))?.focus();
  }

  const count = pages.length;
  $('pages-section').hidden = count === 0;
  $('count').textContent = `(${count})`;
  $('order-hint').hidden = count < 2;
  document.querySelector('main').classList.toggle('has-pages', count > 0);
  $('drop-label').textContent = count ? 'Add more images' : 'Choose images';
}

function button(text, label, control, disabled, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'icon';
  element.textContent = text;
  element.disabled = disabled;
  element.dataset.control = control;
  element.setAttribute('aria-label', label);
  element.addEventListener('click', onClick);
  return element;
}

function isAfter(event, item) {
  const rect = item.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2;
}

function clearMarkers() {
  for (const item of document.querySelectorAll('.drop-before, .drop-after')) {
    item.classList.remove('drop-before', 'drop-after');
  }
}

// ---- Making the PDF

async function make() {
  if (!pages.length) {
    return;
  }
  forgetResult();
  $('make').disabled = true;
  const progress = (done, total) => say(total === 1 ? 'Making the PDF…' : `Making page ${Math.min(done + 1, total)} of ${total}…`);
  progress(0, pages.length);

  try {
    const pdf = await imagesToPdf(pages.map((page) => page.file), progress);
    resultUrl = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    const name = `${pages[0].file.name.replace(/\.[^.]*$/, '') || 'images'}.pdf`;

    $('details').textContent = `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} · ${sizeText(pdf.length)}`;
    $('download').href = resultUrl;
    $('download').download = name;
    $('open').href = resultUrl;
    $('result').hidden = false;
    say(`${name} is ready.`);
  } catch (error) {
    say(error.message, true);
  } finally {
    $('make').disabled = false;
  }
}

// ---- Start

$('file').addEventListener('change', async (event) => {
  await add(event.target.files);
  event.target.value = '';
});
$('make').addEventListener('click', make);
$('clear').addEventListener('click', () => {
  for (const page of pages) {
    URL.revokeObjectURL(page.url);
  }
  pages = [];
  forgetResult();
  draw();
  say('All pages removed.');
});

// Files dropped anywhere on the page are added; a page dragged within the list is moved instead.
const drop = $('drop');
for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (event) => {
    if (!dragged && event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      drop.classList.add('over');
    }
  });
}
for (const type of ['dragleave', 'drop']) {
  document.addEventListener(type, () => drop.classList.remove('over'));
}
document.addEventListener('drop', (event) => {
  if (!dragged && event.dataTransfer?.files.length) {
    event.preventDefault();
    add(event.dataTransfer.files);
  }
});
