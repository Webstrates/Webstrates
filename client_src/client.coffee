$(document).ready () =>
    sharejsDoc = window.location.pathname[1..window.location.pathname.length]
    if sharejsDoc.length == 0
        throw "Error: No document id provided"
    
    openDoc sharejsDoc, $('body').get(0)