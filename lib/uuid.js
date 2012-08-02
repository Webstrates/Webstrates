(function() {

  window.uuid = function() {
    var href, i, match, parts, sum, time, ua_string, _i, _len;
    parts = new Array(4);
    time = Math.round(new Date().getTime() / 1000);
    parts[0] = time.toString(16).substring(0, 8);
    ua_string = window.navigator.userAgent;
    match = ua_string.match(/\d+/g);
    if (!match) throw 'Invalid browser version string';
    sum = 0;
    for (_i = 0, _len = match.length; _i < _len; _i++) {
      i = match[_i];
      sum += parseInt(i, 10);
    }
    parts[1] = (sum * sum * sum).toString(16).substring(0, 6);
    href = window.location.href;
    parts[2] = (href.length * href.length * href.length).toString(16).substring(0, 4);
    parts[3] = Math.random().toString().substring(2);
    parts[3] = parseInt(parts[3], 10).toString(16).substring(0, 6);
    return parts.join('');
  };

}).call(this);
