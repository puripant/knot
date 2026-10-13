var line = d3.line()
  .curve(d3.curveBasis);

var svg = d3.select("svg")
  .call(d3.drag()
    .container(function() { return this; })
    .subject(function() { var p = [d3.event.x, d3.event.y]; return [p, p]; })
    .on("start",dragstarted));
var width = +svg.attr("width");
var height = +svg.attr("height");

var mouseX = width/2;
var mouseY = height/2;
function dragstarted() {
	var d = d3.event.subject;
	var active = svg.append("path").datum(d);
	var x0 = d3.event.x;
	var y0 = d3.event.y;

	d3.event.on("drag", function() {
		var x1 = d3.event.x;
		var y1 = d3.event.y;
		var dx = x1 - x0;
		var dy = y1 - y0;

		mouseX = x1;
		mouseY = y1;

		if (dx * dx + dy * dy > 100) {
			d.push([x0 = x1, y0 = y1]);
		} else {
			d[d.length - 1] = [x1, y1];
		}
		active.attr("d", line);
	});
}

//keyboard
document.addEventListener('keydown', onDocumentKeyDown, false);
function onDocumentKeyDown(event) {
	event = event || window.event;
	var keycode = event.keyCode;
	switch(keycode){
  	case 18: //alt key
			controls.enabled = true;
			break;
	}
	document.addEventListener('keyup', onDocumentKeyUp, false);
}
function onDocumentKeyUp(event) {
	controls.enabled = false;
	document.addEventListener('keydown', onDocumentKeyDown, false);
}

var scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

var aspect = width / height;
var camera = new THREE.PerspectiveCamera(100, aspect, 0.1, 1000);
camera.position.z = 5;

var renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setSize( width, height );
renderer.setClearColor(0xffffff, 0);
document.body.appendChild(renderer.domElement);

//TODO rotation controls
var controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enabled = false;
controls.addEventListener('change', render);

var hemiLight = new THREE.HemisphereLight(0xffffff, 0x666666, 0.5);
scene.add(hemiLight);

// var geometry = new THREE.CylinderGeometry( 0, 10, 30, 4, 1 );
// var material =  new THREE.MeshPhongMaterial( { color:0xffffff, shading: THREE.FlatShading } );
// for ( var i = 0; i < 500; i ++ ) {
// 	var mesh = new THREE.Mesh( geometry, material );
// 	mesh.position.x = ( Math.random() - 0.5 ) * 1000;
// 	mesh.position.y = ( Math.random() - 0.5 ) * 1000;
// 	mesh.position.z = ( Math.random() - 0.5 ) * 1000;
// 	mesh.updateMatrix();
// 	mesh.matrixAutoUpdate = false;
// 	scene.add( mesh );
// }

var ccw = function(A, B, C) {
  return (C[1]-A[1]) * (B[0]-A[0]) > (B[1]-A[1]) * (C[0]-A[0]);
}
var intersect = function(A, B, C, D) { //check line AB and CD
  return ccw(A,C,D) != ccw(B,C,D) && ccw(A,B,C) != ccw(A,B,D);
}

var material = new THREE.MeshNormalMaterial(); //new THREE.MeshLambertMaterial();

var xs = [];
var ys = [];
var render = function() {
	requestAnimationFrame(render);
	controls.update();

	var newX =  (mouseX -  width/2)/50;
	var newY = -(mouseY - height/2)/50;
	if(xs.length == 0 || Math.pow(newX - xs[xs.length-1], 2) + Math.pow(newY - ys[ys.length-1], 2) > 0.5) {
		xs.push(newX);
		ys.push(newY);

		var oldTube = scene.getObjectByName("tube");
		scene.remove(oldTube);

		var customCurve = THREE.Curve.create(
	    function(scale) { //custom curve constructor
				this.scale = (scale === undefined) ? 1 : scale;
	    },

	    function (t) { //getPoint: t is between 0-1
				var mapped = t*(xs.length-2) + 1;
				var idx = Math.floor(mapped);
				var tx, ty, tz = 0;
				if (idx == xs.length-1) {
					tx = xs[idx];
					ty = ys[idx];
				} else {
					tx = (xs[idx+1] - xs[idx])*(mapped-idx) + xs[idx];
					ty = (ys[idx+1] - ys[idx])*(mapped-idx) + ys[idx];

          // check if the segments intersect. If so, pull the newer one up.
          for (var j = 0; j < idx; j++) {
            if (intersect([xs[j], ys[j]], [xs[j+1], ys[j+1]], [xs[idx], ys[idx]], [xs[idx+1], ys[idx+1]])) {
              tz = 1;
              break;
            }
          }
				}

        //TODO apply physical simulation; try https://github.com/schteppe/cannon.js

				return new THREE.Vector3(tx, ty, tz).multiplyScalar(this.scale);
	    }
		);
		var geometry = new THREE.TubeGeometry(new customCurve(), xs.length, 0.2, 8, false);
		var tube = new THREE.Mesh(geometry, material);
		tube.name = "tube"

		// var helper = new THREE.EdgesHelper(tube, 0xffffff); // or THREE.WireframeHelper
		// helper.material.linewidth = 1;
		// scene.add(helper);

		scene.add(tube);
	}

	renderer.render(scene, camera);
};

render();
