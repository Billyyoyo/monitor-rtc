<template>
    <video ref="desktopView" playsinline width="100%" @onloadedmetadata="playStream"></video>
</template>

<script>
    module.exports = {
        props: ['value'],
        data: function () {
            return {
                who: 'world'
            }
        },
        mounted() {
            this.$emit('on-video-created')
            getScreenMedias().then((stream) => {
                console.log('get desktop video stream')
                    let video = this.$refs.desktopView
                video.srcObject = stream
                video.onloadedmetadata = (e) => video.play()
            }).catch(err=>{
                console.log(err)
            })
        },
        methods:{
            playStream(){
                console.log('start desktop play')
                this.$refs.desktopView.play()
            }
        },
        destroyed() {
        }
    }
</script>

<style scoped>
    .hello {
        background-color: red;
    }
</style>