/* Aplica el tema guardado antes de pintar, para que no haya parpadeo. */
(function () {
  try {
    var t = localStorage.getItem('tema');
    if (t === 'claro' || t === 'oscuro') {
      document.documentElement.dataset.tema = t;
    }
  } catch (e) {}
})();
