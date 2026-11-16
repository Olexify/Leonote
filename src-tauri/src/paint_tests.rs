//! The `.leopaint` container: what a saved drawing must survive.
//!
//! The promise this file guards is "a drawing you made in Leonote is still
//! eight PNGs and a JSON file in ten years" — so the tests check the archive
//! from the outside, with a plain zip reader, not through our own `unpack`.

use crate::paint::*;
use std::io::Read;

fn manifest(layers: &[&str]) -> String {
    let ls: Vec<String> = layers
        .iter()
        .enumerate()
        .map(|(i, id)| {
            format!(
                r#"{{"id":"{id}","name":"Layer {n}","file":"layers/{id}.png","opacity":1,"visible":true,"locked":false,"alphaLock":false,"blend":"normal"}}"#,
                id = id,
                n = i + 1
            )
        })
        .collect();
    format!(
        r##"{{"format":"leopaint","version":1,"app":"Leonote 1.0.0","created":"2026-09-18T10:00:00.000Z","modified":"2026-09-18T10:31:00.000Z","width":2048,"height":1536,"dpi":144,"background":"#ffffff","selected":"{}","layers":[{}]}}"##,
        layers.last().copied().unwrap_or(""),
        ls.join(",")
    )
}

/// A believable PNG header plus some bytes. Nothing here decodes pixels, but
/// entries that look like PNGs keep the fixtures honest.
fn png(seed: u8) -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    v.extend((0..300u32).map(|i| (i as u8) ^ seed));
    v
}

/// Each entry is within the limit; naming the same one twice must not get past it.
#[test]
fn a_small_file_cannot_unpack_past_the_limit_by_naming_one_entry_many_times() {
    use std::io::Write;
    let mut out = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut out));
        let opts = zip::write::SimpleFileOptions::default();
        zw.start_file("doc.json", opts).unwrap();
        zw.write_all(br#"{"layers":[{"id":"a","file":"layers/x.png"},{"id":"b","file":"layers/x.png"}]}"#).unwrap();
        zw.start_file("layers/x.png", opts).unwrap();
        zw.write_all(&vec![0u8; 270 * 1024 * 1024]).unwrap();
        zw.finish().unwrap();
    }
    assert!(unpack(&out).unwrap_err().contains("too large"));
}

#[test]
fn a_container_is_a_plain_zip_anyone_can_open() {
    let ls = vec![("bottom".to_string(), png(1)), ("top".to_string(), png(2))];
    let bytes = pack(&manifest(&["bottom", "top"]), &ls, Some(&png(9))).unwrap();

    // read it back with the zip crate directly - no Leonote code involved
    let mut zr = zip::ZipArchive::new(std::io::Cursor::new(&bytes[..])).unwrap();
    let names: Vec<String> = zr.file_names().map(|s| s.unwrap().into_owned()).collect();
    assert!(names.contains(&"doc.json".to_string()), "{:?}", names);
    assert!(names.contains(&"layers/bottom.png".to_string()), "{:?}", names);
    assert!(names.contains(&"layers/top.png".to_string()), "{:?}", names);
    assert!(names.contains(&"thumb.png".to_string()), "{:?}", names);

    let mut json = String::new();
    zr.by_name("doc.json").unwrap().read_to_string(&mut json).unwrap();
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["format"], "leopaint");
    assert_eq!(v["width"], 2048);
    assert_eq!(v["layers"].as_array().unwrap().len(), 2);

    let mut raw = Vec::new();
    zr.by_name("layers/top.png").unwrap().read_to_end(&mut raw).unwrap();
    assert_eq!(raw, png(2), "a layer's PNG must come back byte for byte");
}

#[test]
fn round_trip_keeps_every_layer_and_its_order() {
    let ls = vec![
        ("a1".to_string(), png(3)),
        ("b2".to_string(), png(4)),
        ("c3".to_string(), png(5)),
    ];
    let m = manifest(&["a1", "b2", "c3"]);
    let bytes = pack(&m, &ls, None).unwrap();
    let (back, layers, thumb) = unpack(&bytes).unwrap();
    assert_eq!(back, m);
    assert!(thumb.is_none());
    assert_eq!(layers.len(), 3);
    assert_eq!(layers[0].0, "a1", "layers come back bottom-first, as written");
    assert_eq!(layers[2].0, "c3");
    assert_eq!(layers[1].1, png(4));
}

#[test]
fn a_layer_whose_png_is_missing_opens_as_an_empty_layer() {
    // manifest names three, the archive holds two: half a drawing beats none
    let ls = vec![("a1".to_string(), png(3)), ("c3".to_string(), png(5))];
    let bytes = pack(&manifest(&["a1", "b2", "c3"]), &ls, None).unwrap();
    let (_, layers, _) = unpack(&bytes).unwrap();
    assert_eq!(layers.len(), 2);
    assert_eq!(layers.iter().map(|l| l.0.as_str()).collect::<Vec<_>>(), vec!["a1", "c3"]);
}

#[test]
fn a_manifest_that_is_not_json_is_never_written() {
    let e = pack("not json at all", &[], None).unwrap_err();
    assert!(e.contains("not JSON"), "{}", e);
    assert!(pack("[1,2,3]", &[], None).is_err(), "an array is not a manifest");
}

#[test]
fn a_file_that_is_not_a_zip_says_so_plainly() {
    let e = unpack(b"this is a text file").unwrap_err();
    assert!(e.contains("not a Leonote drawing"), "{}", e);
}

#[test]
fn a_zip_with_no_manifest_is_refused() {
    let mut out = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut out));
        zw.start_file("hello.txt", zip::write::SimpleFileOptions::default()).unwrap();
        use std::io::Write;
        zw.write_all(b"hi").unwrap();
        zw.finish().unwrap();
    }
    let e = unpack(&out).unwrap_err();
    assert!(e.contains("doc.json"), "{}", e);
}

/// A layer id becomes a file name inside the archive. Anything that could
/// climb out of `layers/` must be refused at pack time.
#[test]
fn layer_ids_cannot_be_paths() {
    for bad in ["../evil", "a/b", "a\\b", "", "with space", "c:evil"] {
        let ls = vec![(bad.to_string(), png(1))];
        assert!(pack(&manifest(&["ok"]), &ls, None).is_err(), "accepted {:?}", bad);
    }
    assert!(pack(&manifest(&["ok"]), &[("Ok-9_z".to_string(), png(1))], None).is_ok());
}

/// And a hand-edited manifest must not be able to point at anything outside
/// `layers/` either.
#[test]
fn a_manifest_cannot_point_outside_the_layers_folder() {
    let m = r#"{"format":"leopaint","version":1,"width":8,"height":8,"layers":[
        {"id":"a1","file":"../../secret.png"},
        {"id":"b2","file":"doc.json"}
    ]}"#;
    let bytes = pack(m, &[("a1".to_string(), png(1)), ("b2".to_string(), png(2))], None).unwrap();
    let (_, layers, _) = unpack(&bytes).unwrap();
    // both fall back to layers/<id>.png, which is what was actually written
    assert_eq!(layers.len(), 2);
    assert_eq!(layers[0].1, png(1));
    assert_eq!(layers[1].1, png(2));
}

#[test]
fn too_many_layers_is_refused_rather_than_written() {
    let ls: Vec<(String, Vec<u8>)> = (0..MAX_LAYERS + 1).map(|i| (format!("l{}", i), png(i as u8))).collect();
    assert!(pack(&manifest(&["l0"]), &ls, None).is_err());
}

#[test]
fn a_mask_travels_beside_its_layer_and_comes_back_under_its_own_id() {
    let m = r#"{"format":"leopaint","version":2,"width":4,"height":4,"layers":[
        {"id":"a1","kind":"raster","file":"layers/a1.png","mask":"layers/a1-mask.png"},
        {"id":"adj","kind":"adjust","file":null,"adjust":{"type":"invert"},"mask":"layers/adj-mask.png"},
        {"id":"grp","kind":"group","file":null}
    ]}"#;
    let blobs = [("a1".to_string(), png(1)), ("a1-mask".to_string(), png(2)), ("adj-mask".to_string(), png(3))];
    let bytes = pack(m, &blobs, None).unwrap();
    let (_, layers, _) = unpack(&bytes).unwrap();
    let ids: Vec<&str> = layers.iter().map(|(id, _)| id.as_str()).collect();
    // an adjustment and a group have no pixels of their own; the masks do
    assert_eq!(ids, vec!["a1", "a1-mask", "adj-mask"]);
    assert_eq!(layers[1].1, png(2));
    assert_eq!(layers[2].1, png(3));
}

#[test]
fn a_mask_path_outside_the_layers_folder_is_ignored() {
    let m = r#"{"format":"leopaint","version":2,"width":4,"height":4,"layers":[
        {"id":"a1","file":"layers/a1.png","mask":"../secrets.png"},
        {"id":"b2","file":"layers/b2.png","mask":"doc.json"}
    ]}"#;
    let bytes = pack(m, &[("a1".to_string(), png(1)), ("b2".to_string(), png(2))], None).unwrap();
    let (_, layers, _) = unpack(&bytes).unwrap();
    assert_eq!(layers.len(), 2, "neither odd mask path produced a blob");
}

#[test]
fn every_layer_may_have_a_mask_but_no_more_than_that() {
    let mut ls: Vec<(String, Vec<u8>)> = (0..MAX_LAYERS).map(|i| (format!("l{}", i), png(i as u8))).collect();
    ls.extend((0..MAX_LAYERS).map(|i| (format!("l{}-mask", i), png(i as u8))));
    assert!(pack(&manifest(&["l0"]), &ls, None).is_ok());
    ls.push(("extra-mask".to_string(), png(9)));
    assert!(pack(&manifest(&["l0"]), &ls, None).is_err());
}

#[test]
fn base64_round_trips_every_length() {
    for n in 0..300usize {
        let src: Vec<u8> = (0..n).map(|i| (i * 37 % 251) as u8).collect();
        let enc = b64_encode(&src);
        assert_eq!(enc.len() % 4, 0, "base64 is padded to a multiple of four");
        assert_eq!(b64_decode(&enc).unwrap(), src, "length {}", n);
    }
}

#[test]
fn base64_matches_the_canonical_encoding() {
    assert_eq!(b64_encode(b""), "");
    assert_eq!(b64_encode(b"f"), "Zg==");
    assert_eq!(b64_encode(b"fo"), "Zm8=");
    assert_eq!(b64_encode(b"foo"), "Zm9v");
    assert_eq!(b64_encode(b"foob"), "Zm9vYg==");
    assert_eq!(b64_encode(b"fooba"), "Zm9vYmE=");
    assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
    assert_eq!(b64_decode("Zm9vYmFy").unwrap(), b"foobar");
}

/// The webview hands canvas bitmaps over as data URLs, sometimes with line
/// breaks in them. Both must decode to the same bytes.
#[test]
fn base64_tolerates_a_data_url_prefix_and_whitespace() {
    assert_eq!(b64_decode("data:image/png;base64,Zm9vYmFy").unwrap(), b"foobar");
    assert_eq!(b64_decode("Zm9v\nYmFy\r\n").unwrap(), b"foobar");
    assert!(b64_decode("not base64 !!!").is_none());
}

/// The point of the format: a drawing saved today opens with nothing but a
/// zip reader and a JSON parser.
#[test]
fn the_whole_document_can_be_recovered_without_leonote() {
    let ls = vec![("sky".to_string(), png(11)), ("hills".to_string(), png(22))];
    let bytes = pack(&manifest(&["sky", "hills"]), &ls, Some(&png(33))).unwrap();

    let mut zr = zip::ZipArchive::new(std::io::Cursor::new(&bytes[..])).unwrap();
    let mut json = String::new();
    zr.by_name("doc.json").unwrap().read_to_string(&mut json).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&json).unwrap();

    let mut recovered = Vec::new();
    for l in doc["layers"].as_array().unwrap() {
        let file = l["file"].as_str().unwrap();
        let mut buf = Vec::new();
        zr.by_name(file).unwrap().read_to_end(&mut buf).unwrap();
        recovered.push((l["name"].as_str().unwrap().to_string(), buf));
    }
    assert_eq!(recovered.len(), 2);
    assert_eq!(recovered[0].0, "Layer 1");
    assert_eq!(recovered[0].1, png(11));
    assert_eq!(recovered[1].1, png(22));
}
